export function validate(value: string) {
  console.error('Unable to decode record %s', value);
  console.warn('Discarded invalid record {}', value);
  throw new Error('Unsupported record ' + value + ': invalid type');
}

export function dynamic(value: string) {
  throw value;
}

// throw new Error('Comment is not an error site');
const ordinary = 'throw new Error("Text is not an error site")';
