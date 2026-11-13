import { Command } from 'commander';
const program = new Command();
function serve(opts) {
  function shadow(opts) { return opts.verbose; }
  return opts.verbose;
}
program.option('--verbose').action(serve);
const options = program.opts();
export function readOptions() { return options.verbose; }
export function direct() { return program.opts().verbose; }
export function unrelated(opts) { return opts.verbose; }
export function shadow(options) { return options.verbose; }
const other = new Command();
const args = other.opts();
export function otherParser() { return args.verbose; }
