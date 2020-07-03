
export {}

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeWithinRange(min,max) : R
    }
  }
}

expect.extend({
  toBeWithinRange(received, min,max) {
    return {
      pass: received >= min && received <= max,
      message: () => `Should be within ${min}..${max} range`,
    }
  }
})
