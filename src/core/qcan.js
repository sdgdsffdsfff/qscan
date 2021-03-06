const fs = require('fs');
const path = require('path');
const wd = require('wd');
const async = require('async');
const applescript = require('applescript');
const Queue = require('queue');
const EventEmitter = require('events').EventEmitter;
const shelljs = require('shelljs');
const logger = require('../logger');
const {
    handleError,
    addListener,
    dispatch
} = require('../util');

// 本地 Host
const LOCAL_HOST = '127.0.0.1';
// 默认的等待时间
const WAIT_TIMEOUT = 15 * 1000;
// 队列配置
const QUEUE_OPTS = {
    concurrency: 1, // 并发任务数1，等于串行
    timeout: 10 * 60 * 1000, // 单个任务超时，10分钟
    autostart: true // 有任务自动执行
};
// 默认的 Model
const DEFAULT_MODEL_PATH = path.join(__dirname, '../models');
// 默认的配置文件路径
const DEFAULT_MODEL_OPTS_PATH = path.join(process.env['HOME'], '.qscanrc');

class QScan extends EventEmitter {
    constructor({
        customModel,
        modelOpts
    }) {
        super();
        // Models
        this.models = {};
        // 队列
        this.queues = {};
        // 读取配置 默认从 ~/.qscanrc 读取，也可以传进来
        if (modelOpts) {
            if (typeof modelOpts === 'string' && fs.existsSync(modelOpts)) {
                modelOpts = JSON.parse(fs.readFileSync(modelOpts, 'UTF-8'));
            }
        } else if (fs.existsSync(DEFAULT_MODEL_OPTS_PATH)) {
            modelOpts = JSON.parse(
                fs.readFileSync(DEFAULT_MODEL_OPTS_PATH, 'UTF-8')
            );
        } else {
            modelOpts = {};
        }

        // 读取默认的 Model
        fs.readdirSync(DEFAULT_MODEL_PATH).forEach(file => {
            if (path.extname(file) === '.js') {
                this.__loadModelFile({
                    modelFilePath: path.join(DEFAULT_MODEL_PATH, file),
                    modelOpts
                });
            }
        });
        // 读取自定义 model，可以从指定目录读取，或者直接传入对象(key-value)或数组
        if (customModel) {
            if (typeof customModel === 'string' && fs.existsSync(customModel)) {
                fs.readdirSync(customModel, file => {
                    if (path.extname(file) === '.js') {
                        this.__loadModelFile({
                            modelFilePath: path.join(customModel, file),
                            modelOpts
                        });
                    }
                });
            } else {
                Object.keys(customModel).forEach(key => {
                    const model = customModel[key];
                    const opts = modelOpts[model.name || 'default'] || {};
                    this.loadModel({
                        model,
                        ...opts
                    });
                });
            }
        }
    }
    // 检查环境
    doctor(cb) {
        const tasks = [];
        let ports = [],
            devices = [],
            connectDevices = [];
        tasks.push(cb => {
            // Check Appium
            if (!shelljs.which('appium')) {
                cb('Not Found Appium');
            } else {
                cb(null);
            }
        });

        if (this.models) {
            let appServers = shelljs
                .exec('ps | grep "appium"', {
                    silent: true
                })
                .stdout.trim()
                .split('\n');
            appServers.forEach(item => {
                let devicesRes = item.match(/[-U]{1} ([0-9A-Za-z]+)/);
                devicesRes && devices.push(devicesRes[1]);
                let portsRes = item.match(/[-p]{1} ([0-9]+)/);
                portsRes && ports.push(portsRes[1]);
            });

            connectDevices = shelljs
                .exec('adb devices', {
                    silent: true
                })
                .stdout.trim()
                .split('\n')
                .map(item => {
                    return item.split('\t')[0].trim();
                });
        }

        Object.keys(this.models).forEach(key => {
            let modelName = this.models[key].name;
            if (modelName && this.models[modelName]) {
                const model = this.models[modelName];

                if (model.udid) {
                    tasks.push(cb => {
                        // Check Devices
                        // model.udid
                        if (!connectDevices.includes(model.udid)) {
                            cb(`Can Not Found device: ${model.udid}`);
                            return;
                        }
                        // appium -u
                        if (!devices.includes(model.udid)) {
                            cb(
                                `There is no appium server at devices: ${
                                    model.udid
                                }`
                            );
                            return;
                        }
                        logger.success('The devices is ok');
                        cb(null);
                    });
                }
                if (model.port) {
                    tasks.push(cb => {
                        // Check Appium Process
                        if (!ports.includes(model.port)) {
                            cb(
                                `There is no appium server at port: ${
                                    model.port
                                }`
                            );
                            return;
                        }
                        logger.success('The port is ok');
                        cb(null);
                    });
                }
                if (model.checkApp) {
                    tasks.push(cb => model.checkApp(cb, model.udid));
                }
            }
        });
        async.series(tasks, cb);
    }
    loadModel({
        model,
        udid,
        port,
        opts
    }) {
        if (udid) {
            model.udid = model.connectOpt.udid = udid;
        }
        if (port) {
            model.port = port;
        }
        if (opts) {
            model.opts = opts;
        }
        this.models[model.name] = model;
    }
    run({
        modelName,
        type
    }, cb) {
        if (!this.queues[modelName]) {
            this.queues[modelName] = new Queue(QUEUE_OPTS);
        }
        let task = {};

        if (this.queues[modelName].length) {
            logger.warn(
                `新任务开始排队, 任务数: ${this.queues[modelName].length}`
            );
        }

        const handle = (callback) => {
            this.__handleDevice({
                modelName,
                type
            }, task,
            err => {
                cb(err);
                callback();
            }
            );
        };
        task.handle = handle;
        this.queues[modelName].push(handle);
        task.stop = () => {
            const index = this.queues[modelName].indexOf(task.handle);
            if (index === -1) { // 正在执行
                if (task.app) {
                    task.app.quit();
                }
                if(shelljs.exec(`ps -A | grep -p ${task.model.port} | cut -c 1-5 | xargs kill`, {
                    silent: true
                }).stdout.trim().split('\n').length > 2) {
                    this.__killByPort(task.model.port);
                } else {    // appium启动中但是检测不到
                    addListener('appiumQuit', app => {
                        app.quit();
                        this.__killByPort(task.model.port);
                    });
                }
                cb();
            } else {
                this.queues[modelName].splice(index, 1);
            }
        }
        return task;
    }
    clone({
        newModelName,
        oldModelName,
        opts
    }) {
        this.models[newModelName] = Object.assign({},
            this.models[oldModelName] || {}, {
                opts
            }
        );
    }
    exit() {
        logger.info('已断开与手机连接');

        for (const modelName in this.models) {
            if (this.models.hasOwnProperty(modelName)) {
                const model = this.models[modelName];
                this.__killByPort(model.port);
            }
        }
    }
    __killByPort(port) {
        shelljs.exec(
            `ps -A | grep -p ${port} | cut -c 1-5 | xargs kill`, {
                silent: true
            }
        );
    }
    __loadModelFile({
        modelFilePath,
        modelOpts
    }) {
        const model = require(modelFilePath);
        const opts = modelOpts[model.name || 'default'] || {};
        this.loadModel({
            model,
            ...opts
        });
    }
    __connectAppium(model, task, cb) {

        const {
            port,
            udid
        } = model;

        const pids = shelljs
            .exec(`ps -A | awk '/appium/{print $1 " " $4 " " $7 " " $9}'`, {
                silent: true
            })
            .stdout.split('\n')
            .filter(t => {
                const l = t.trim().split(' ');
                return l[1] === 'node' && +l[2] === +port && l[3] === udid;
            });

        if (pids.length) return cb();

        const APPIUM_CLI = shelljs
            .exec('which appium', {
                silent: true
            })
            .stdout.replace('\n', '');

        const script = `tell application "Terminal"
                            activate
                            set theTab to do script ("${APPIUM_CLI} -p ${port} -U ${udid}")
                            set theText to ""

                            repeat while theText = ""
                                tell front window to set theText2 to contents of selected tab as text
                                if (theText2 contains "Welcome to Appium") then
                                    set theText to theText2
                                end if
                            end repeat

                            delay 1
                        end tell`;
        applescript.execString(script, err => {
            cb(err);
        });
    }
    __initConnect(model) {
        return wd
            .promiseChainRemote({
                host: LOCAL_HOST,
                port: model.port
            })
            .init(model.connectOpt)
            .setImplicitWaitTimeout(model.waitTimeout || WAIT_TIMEOUT);
    }
    __checkStatus(model, task, cb) {
        const app = this.__initConnect(model);
        task.app = app;
        dispatch('appiumQuit', app);
        model.checkStatus(app, model.opts, cb);
    }
    __handleDevice({
        modelName,
        type
    }, task, cb) {
        const model = this.models[modelName];

        if (model) {
            task.model = model;
            if (model.types && model.types[type]) {
                this.__connectAppium(model, task, (err, stop) => {
                    if (err) {
                        cb(err);
                    } else if (stop) {
                        cb();
                    } else {
                        // 检测登录状态并登录
                        this.__checkStatus(
                            model, task,
                            (err, app) => {
                                if (!err) {
                                    // 登录成功 可以直接扫码
                                    model.types[type](app, model.opts)
                                        .quit()
                                        .then(() => cb())
                                        .catch(e => {
                                            cb(handleError(e));
                                        });
                                } else {
                                    cb(handleError(err));
                                }
                            }
                        );
                    }
                });
            } else {
                cb(new Error(`Not Found This Type <${type}>.`));
            }
        } else {
            cb(new Error(`Not Found This Model <${modelName}>.`));
        }
    }
}

module.exports = QScan;