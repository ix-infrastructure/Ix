function fail(value: string) {
  throw new TypeError(`Invalid record ${value}: missing field`);
}
fail('sample');
