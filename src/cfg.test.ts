import './cfg'

import {BackupType, BackupTypeUtils} from "./cfg";

describe('BackupTypeUtils', () => {
  test('to file type', () => {
    expect(BackupTypeUtils.toFileType(BackupType.monthly)).toBe('ful');
    expect(BackupTypeUtils.toFileType(BackupType.weekly)).toBe('dif');
    expect(BackupTypeUtils.toFileType(BackupType.daily)).toBe('inc');
  })
  test('from file type', () => {
    expect(BackupTypeUtils.fromFileType('ful')).toStrictEqual<BackupType>(BackupType.monthly);
    expect(BackupTypeUtils.fromFileType('dif')).toStrictEqual<BackupType>(BackupType.weekly);
    expect(BackupTypeUtils.fromFileType('inc')).toStrictEqual<BackupType>(BackupType.daily);
  })
  test('to char flag', () => {
    expect(BackupTypeUtils.toCharFlag(BackupType.monthly)).toBe('M');
    expect(BackupTypeUtils.toCharFlag(BackupType.weekly)).toBe('W');
    expect(BackupTypeUtils.toCharFlag(BackupType.daily)).toBe('D');
  })
  test('from char flag', () => {
    expect(BackupTypeUtils.fromCharFlag('M')).toStrictEqual<BackupType>(BackupType.monthly);
    expect(BackupTypeUtils.fromCharFlag('W')).toStrictEqual<BackupType>(BackupType.weekly);
    expect(BackupTypeUtils.fromCharFlag('D')).toStrictEqual<BackupType>(BackupType.daily);
  })
})
