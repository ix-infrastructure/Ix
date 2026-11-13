import express from "express";
import fastify from "fastify";
import { Command } from "commander";
import yargs from "yargs";
import config from "config";
const app = express();
const server = fastify();
const program = new Command();
function boot() {
  const host = process.env.APP_HOST ?? "localhost";
  const port = process.env.PORT;
  const timeout = config.get("timeout");
  return config.get("server.port") + settings.cache.ttl;
}
function serve(opts) { return opts.verbose; }
function health(req, res) { return res.send("ok"); }
program.option("-v, --verbose", "Verbose", false).action(serve);
yargs.option("limit", { default: 10 }).command("run", "run", {}, serve);
app.get("/health/:id", health);
app.route("/chained").post(health);
server.route({ method: "POST", url: "/jobs", handler: health });
const unrelated = "process.env.FAKE --fake /fake server.fake";
log.get("/not-a-route", health);
