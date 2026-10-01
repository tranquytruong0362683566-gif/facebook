(function (root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.manualCommentContent = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RANDOM_SEPARATOR = /\)\s*:\s*\(/;

  function parse(input) {
    const source = String(input ?? '').trim();
    if (!source) {
      return {
        source,
        variants: [],
        random: false,
        error: 'Hãy nhập ít nhất một nội dung bình luận thủ công.'
      };
    }

    if (!RANDOM_SEPARATOR.test(source)) {
      return { source, variants: [source], random: false, error: '' };
    }

    if (!source.startsWith('(') || !source.endsWith(')')) {
      return {
        source,
        variants: [],
        random: true,
        error: 'Danh sách ngẫu nhiên phải đúng dạng (nội dung1):(nội dung2):(nội dung3).'
      };
    }

    const variants = source
      .slice(1, -1)
      .split(RANDOM_SEPARATOR)
      .map(value => value.trim());

    if (variants.length < 2 || variants.some(value => !value)) {
      return {
        source,
        variants: [],
        random: true,
        error: 'Mỗi cặp ngoặc trong danh sách ngẫu nhiên phải chứa một nội dung.'
      };
    }

    return { source, variants, random: true, error: '' };
  }

  function getRandomUnit(randomSource) {
    let value;
    if (typeof randomSource === 'function') value = Number(randomSource());
    else if (randomSource !== undefined) value = Number(randomSource);
    else if (globalThis.crypto?.getRandomValues) {
      const buffer = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buffer);
      value = buffer[0] / 0x100000000;
    } else {
      value = Math.random();
    }

    if (!Number.isFinite(value)) value = Math.random();
    return Math.max(0, Math.min(0.9999999999999999, value));
  }

  function pick(parsedOrInput, randomSource) {
    const parsed = typeof parsedOrInput === 'string'
      ? parse(parsedOrInput)
      : parsedOrInput;

    if (!parsed || parsed.error || !Array.isArray(parsed.variants) || !parsed.variants.length) {
      const error = new Error(parsed?.error || 'Chưa có nội dung bình luận thủ công hợp lệ.');
      error.code = parsed?.source ? 'MANUAL_COMMENT_FORMAT_INVALID' : 'MANUAL_COMMENT_REQUIRED';
      throw error;
    }

    if (!parsed.random || parsed.variants.length === 1) return parsed.variants[0];
    const index = Math.floor(getRandomUnit(randomSource) * parsed.variants.length);
    return parsed.variants[index];
  }

  return Object.freeze({ parse, pick });
}));
