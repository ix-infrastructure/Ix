export function normalize() {
  return [process.env.APP_HOST.trim(), process.env['APP_PORT'].length,
    process.env.APP_MODE?.toLowerCase(), process.env.APP_HOST];
}
process.env.WRITE_ONLY = 'localhost';
const unrelated = 'process.env.FAKE.trim()';
