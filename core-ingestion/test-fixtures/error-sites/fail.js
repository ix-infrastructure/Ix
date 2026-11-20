function fail(value) {
  throw new TypeError(`Invalid record ${value}: missing field`);
}
fail('sample');
