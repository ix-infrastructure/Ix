const express = require('express');
const config = require('config');
const { Command } = require('commander');
const app = express();
const program = new Command();
function boot() { return `${process.env.APP_HOST}:${config.get('server.port')}`; }
function health(req, res) { res.send('ok'); }
function serve(opts) { return opts.verbose; }
program.option('--verbose', 'Verbose', false).action(serve);
app.get('/commonjs', health);
const example = "process.env.FAKE config.get('server.fake') --fake";
logger.get('/not-a-route');
