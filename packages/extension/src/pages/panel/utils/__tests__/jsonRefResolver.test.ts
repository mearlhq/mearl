import { describe, it, expect } from 'vitest';
import { resolveJsonRefs } from '../jsonRefResolver';

describe('resolveJsonRefs', () => {
  it('resolves a simple property ref to a copy of the target', () => {
    const input = {
      model: {
        applyDetail: {
          contact: { tag: { bold: false, color: '#919499' } },
          title: { $ref: '$.model.applyDetail.contact.tag' },
        },
      },
    };

    const out = resolveJsonRefs(input);

    expect(out.model.applyDetail.title).toEqual({ bold: false, color: '#919499' });
    // resolved value is a copy, not the same object reference (mock data must be
    // decoupled from its source)
    expect(out.model.applyDetail.title).not.toBe(out.model.applyDetail.contact.tag);
  });

  it('resolves refs through array indexes', () => {
    const input = {
      model: {
        list: [{ position: { journeyIndex: 0, segmentIndex: 0 } }],
        copy: { $ref: '$.model.list[0].position' },
      },
    };

    const out = resolveJsonRefs(input);

    expect(out.model.copy).toEqual({ journeyIndex: 0, segmentIndex: 0 });
  });

  it('resolves a server-root ref after model is wrapped as client data', () => {
    const input = {
      api: 'mtop.flight.detail',
      data: {
        models: {
          flight: {
            oldSegments: [{ flightNo: 'UA2210' }],
            previousSegment: { $ref: '$.model.models.flight.oldSegments[0]' },
          },
        },
      },
    };

    const out = resolveJsonRefs(input);

    expect(out.data.models.flight.previousSegment).toEqual({ flightNo: 'UA2210' });
  });

  it('resolves a wrapped ref from an unwrapped payload', () => {
    const input = {
      models: {
        flight: {
          oldSegments: [{ flightNo: 'UA2210' }],
          previousSegment: { $ref: '$.model.models.flight.oldSegments[0]' },
        },
      },
    };

    const out = resolveJsonRefs(input);

    expect(out.models.flight.previousSegment).toEqual({ flightNo: 'UA2210' });
  });

  it('prefers an exact path when model and data are both present', () => {
    const input = {
      model: { value: 'server' },
      data: { value: 'client', copy: { $ref: '$.model.value' } },
    };

    const out = resolveJsonRefs(input);

    expect(out.data.copy).toBe('server');
  });

  it('resolves a ref pointing at a whole object subtree', () => {
    const input = {
      model: {
        applyDetail: { applyType: 2, contact: { name: '李伟广' } },
        detailList: [{ applyDetail: { $ref: '$.model.applyDetail' } }],
      },
    };

    const out = resolveJsonRefs(input);

    expect(out.model.detailList[0].applyDetail).toEqual({
      applyType: 2,
      contact: { name: '李伟广' },
    });
  });

  it('resolves refs nested inside a resolved target', () => {
    const input = {
      model: {
        applyDetail: { contact: { tag: { bold: false, color: '#919499' } } },
        expense: {
          deductDetails: [{ oriExpense: { amount: { $ref: '$.model.applyDetail.contact.tag' } } }],
        },
        oriDeductMoney: { $ref: '$.model.expense.deductDetails[0].oriExpense' },
      },
    };

    const out = resolveJsonRefs(input);

    expect(out.model.oriDeductMoney).toEqual({
      amount: { bold: false, color: '#919499' },
    });
  });

  it('breaks circular references with null instead of recursing forever', () => {
    const input = {
      a: { name: 'a', self: { $ref: '$' } },
    };

    const out = resolveJsonRefs<any>(input);

    expect(out.a.name).toBe('a');
    // first hop resolves the root, the second hop into the same `$` is the cycle
    expect(out.a.self.a.name).toBe('a');
    expect(out.a.self.a.self).toBeNull();
  });

  it('leaves a dangling ref untouched', () => {
    const input = { a: { $ref: '$.does.not.exist' } };

    const out = resolveJsonRefs(input);

    expect(out.a).toEqual({ $ref: '$.does.not.exist' });
  });

  it('does not treat an object with extra keys as a ref node', () => {
    const input = { a: { $ref: '$.b', other: 1 }, b: { v: 2 } };

    const out = resolveJsonRefs(input);

    expect(out.a).toEqual({ $ref: '$.b', other: 1 });
  });

  it('returns primitives and nullish values unchanged', () => {
    expect(resolveJsonRefs(null)).toBeNull();
    expect(resolveJsonRefs(42)).toBe(42);
    expect(resolveJsonRefs('x')).toBe('x');
  });

  it('handles multiple shared refs to the same target independently', () => {
    const input = {
      tag: { color: 'red' },
      a: { $ref: '$.tag' },
      b: { $ref: '$.tag' },
    };

    const out = resolveJsonRefs(input);

    expect(out.a).toEqual({ color: 'red' });
    expect(out.b).toEqual({ color: 'red' });
    expect(out.a).not.toBe(out.b);
  });
});
