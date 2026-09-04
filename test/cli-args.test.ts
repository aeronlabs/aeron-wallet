import { describe, expect, it } from 'vitest'
import { parseMethod, takeFlag } from '../src/cli-args.js'

describe('takeFlag', () => {
  it('lifts the flag and its value out of the arguments', () => {
    expect(takeFlag(['pay', '--method', 'GET', 'https://x.example'], 'method')).toEqual({
      value: 'GET',
      rest: ['pay', 'https://x.example'],
    })
  })

  it('leaves the arguments alone when the flag is absent', () => {
    expect(takeFlag(['https://x.example', '{}'], 'method')).toEqual({
      value: undefined,
      rest: ['https://x.example', '{}'],
    })
  })

  it('does not mutate what it was given', () => {
    const argv = ['--method', 'GET', 'url']
    takeFlag(argv, 'method')
    expect(argv).toEqual(['--method', 'GET', 'url'])
  })

  it.each([
    ['nothing follows it', ['pay', '--method']],
    ['another flag follows it', ['pay', '--method', '--session', 'abc']],
  ])('refuses a flag with no value when %s', (_label, argv) => {
    expect(() => takeFlag(argv, 'method')).toThrow(/needs a value/)
  })
})

describe('parseMethod', () => {
  it('defaults to POST, which is what most paid endpoints take', () => {
    expect(parseMethod(undefined)).toBe('POST')
  })

  it.each([['get', 'GET'], ['GET', 'GET'], ['patch', 'PATCH']])('reads %s as %s', (raw, expected) => {
    expect(parseMethod(raw)).toBe(expected)
  })

  it('refuses a method it cannot send', () => {
    expect(() => parseMethod('TRACE')).toThrow(/must be one of/)
  })
})
