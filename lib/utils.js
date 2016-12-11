"use strict";

const { Readable } = require("stream");
const net = require("net");
const ipHelper = require("ip-helper");

exports.readLine = readLine;
exports.getIpFromLine = getIpFromLine;
exports.isIterable = isIterable;
exports.createReadableStreamFromString = createReadableStreamFromString;
exports.noop = function noop() {};

const MAX_BUFFER_LINES = 1024;

function readLine(input, options = {}) {
    const maxBufferLines = options.maxBufferLines || MAX_BUFFER_LINES;
    const lines = [];
    let done = false;
    let remaining = "";
    const pending = [];
    const iter = {
        next() {
            if (done && lines.length === 0) {
                return Promise.resolve({
                    done: true,
                });
            } else {
                return new Promise((...args) => {
                    pending.push(args);
                    flush();
                });
            }
        },
        throw(ex) {
            done = true;
            tryResolvePending();
            while (pending.length) {
                const [, reject] = pending.shift();
                reject({
                    value: ex,
                    done: true,
                });
            }
            cleanup();
            return Promise.reject({
                value: ex,
                done: true,
            });
        },
        return(val) {
            done = true;
            tryResolvePending();
            while (pending.length) {
                const [resolve] = pending.shift();
                resolve({
                    value: val,
                    done: true,
                });
            }
            cleanup();
            return Promise.resolve({
                value: val,
                done: true,
            });
        },
    };
    const tryResolvePending = () => {
        let len = Math.min(pending.length, lines.length);
        while (len--) {
            const line = lines.shift();
            const [resolve] = pending.shift();
            resolve({
                value: line,
                done: false,
            });
        }
    };
    const flush = () => {
        tryResolvePending();
        if (done) {
            if (pending.length > 0) {
                while (pending.length) {
                    const [resolve] = pending.shift();
                    resolve({
                        done: true,
                    });
                }
            }
        } else {
            if (pending.length > 0) {
                if (input.isPaused()) {
                    input.resume();
                }
            } else if (lines.length > maxBufferLines) {
                input.pause();
            }
        }
    };
    const onData = data => {
        const _lines = (remaining + data).split("\n");
        remaining = _lines.pop();
        lines.push(..._lines);
        flush();
    };
    const onEnd = () => {
        cleanup();
        done = true;
        if (remaining.length) {
            lines.push(remaining);
            remaining = "";
        }
        flush();
    };
    const onError = err => {
        cleanup();
        done = true;
        iter.throw(err).catch(ex => ex);
    };
    const cleanup = () => {
        if (cleanup.cleared) {
            return;
        }
        cleanup.cleared = true;
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("error", onError);
    };
    input.setEncoding("utf8");
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    return iter;
}

function isIterable(iter) {
    return iter && typeof iter === "object" && typeof iter.next === "function";
}

function createReadableStreamFromString(string, options) {
    return new Readable({
        highWaterMark: options && options.highWaterMark,
        read(size) {
            if (string.length === 0) {
                this.push(null);
                return;
            }
            const { highWaterMark } = this._readableState;
            const length = typeof size === "number" && size !== 0 ? size
                : (highWaterMark === 0 ? string.length : highWaterMark);
            const data = string.slice(0, length);
            string = string.slice(length);
            this.push(data);
        },
    });
}

function getIpFromLine(iter) {
    let ipIter;
    return {
        next() {
            if (ipIter) {
                const { value: ip, done } = ipIter.next();
                if (!done) {
                    return Promise.resolve({
                        value: ip,
                        done: false,
                    });
                } else {
                    ipIter = null;
                }
            }
            const promise = iter.next();
            return promise.then(({ value: ip, done }) => {
                if (done) {
                    return Promise.resolve({
                        done: true,
                    });
                }
                if (net.isIPv4(ip)) {
                    return Promise.resolve({
                        value: ip,
                        done: false,
                    });
                } else if (ipHelper.isIPRange(ip)) {
                    ipIter = ipHelper.convertIPRangeToIterator(ip);
                    return this.next();
                } else {
                    // invalid ip, ignore
                    return this.next();
                }
            });
        },
        throw() {
            ipIter = null;
            iter.throw();
        },
        return() {
            ipIter = null;
            iter.return();
        },
    };
}