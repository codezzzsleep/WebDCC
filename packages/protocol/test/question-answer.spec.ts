import { expect, it } from 'vitest';
import { normalizeQuestionAnswer } from '../src/question-answer.js';

it('NP-06 preserves free text with an empty selection and includes both supplied fields', () => {
  const text = '自由文本\r\n `literal` $HOME ';
  expect(normalizeQuestionAnswer({ selected: [], custom: text }).values).toEqual([text]);
  expect(normalizeQuestionAnswer({ selected: ['Python'], custom: text }).values).toEqual(['Python', text]);
  expect(normalizeQuestionAnswer({ value: ['Python'] }).values).toEqual(['Python']);
  expect(() => normalizeQuestionAnswer({ selected: [1] })).toThrow('格式');
  expect(() => normalizeQuestionAnswer({ selected: null })).toThrow('格式');
});
