export function normalize() {
  return [config.host.trim(), settings.server.host.toLowerCase().trim(),
    cfg.port?.toString(), consume(configuration.token)];
}
config.WRITE_ONLY = 'localhost';
config.refresh();
const unrelated = 'config.FAKE.trim()';
