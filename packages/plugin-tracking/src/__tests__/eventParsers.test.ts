import { describe, it, expect } from 'vitest';
import {
  isTrackingUrl,
  parseAplusRequest,
  parseArmsRequest,
  parseRumRequest,
  parseTrackingRequest,
} from '../eventParsers';

describe('isTrackingUrl', () => {
  it.each([
    'https://gm.mmstat.com/aplus.clk?x=1',
    'https://abc.rum.aliyuncs.com/report',
    'https://arms-retcode.aliyuncs.com/r.png',
    'https://retcode.alicdn.com/log',
    'https://beacon.taobao.com/b',
  ])('recognizes tracking endpoint %s', url => {
    expect(isTrackingUrl(url)).toBe(true);
  });

  it.each(['https://example.com/api', 'https://api.example.com/v1/api.example/1.0/'])(
    'ignores non-tracking url %s',
    url => {
      expect(isTrackingUrl(url)).toBe(false);
    },
  );
});

describe('parseAplusRequest', () => {
  it('returns null for a non-aplus url', () => {
    expect(parseAplusRequest('https://example.com/x')).toBeNull();
  });

  it('returns null for a malformed url that still matches the host pattern', () => {
    expect(parseAplusRequest('foo.mmstat.com/aplus.clk')).toBeNull();
  });

  it('parses a CLK event, taking spm from the gokey params', () => {
    const gokey = encodeURIComponent('spm=a.b.c.d&_p_url=https://page.com');
    const event = parseAplusRequest(`https://gm.mmstat.com/aplus.clk?gmkey=CLK&gokey=${gokey}`, {
      now: 1700000000000,
      sequence: 7,
    });
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      id: 'aplus-7-1700000000000',
      source: 'aplus',
      event_type: 'CLK',
      name: 'a.b.c.d',
    });
    expect(event?._raw.gmkey).toBe('CLK');
    expect(event?._raw._path).toBe('aplus.clk');
    expect(event?._context.view.page_url).toBe('https://page.com');
  });

  it('parses native UT gokey with encoded exposure data', () => {
    const expdata = [
      {
        exargs: { bizArgs: JSON.stringify({ orderId: 'demo-order-1' }) },
        spm: '1.2.dialog_open',
        scm: '',
      },
    ];
    const nativeGokey = encodeURIComponent(
      `spm-cnt=1.2.0.0.token&expdata=${encodeURIComponent(JSON.stringify(expdata))}`,
    );
    const event = parseAplusRequest(
      `https://gm.mmstat.com/demo.1.2.dialog_open?gmkey=EXP&gokey=${nativeGokey}`,
    );

    expect(event).toMatchObject({
      source: 'aplus',
      event_type: 'EXP',
      name: '1.2.dialog_open',
    });
    expect(event?._raw.expdata).toEqual([
      {
        exargs: { bizArgs: { orderId: 'demo-order-1' } },
        spm: '1.2.dialog_open',
        scm: '',
      },
    ]);
  });

  it('parses decoded expdata before decoding nested bizArgs', () => {
    const bizArgs = encodeURIComponent(
      JSON.stringify({
        order_id: 'demo-order-2',
        collect_type: null,
        field_type: 'ITEM',
      }),
    );
    const expdata = [
      {
        exargs: { bizArgs, log_time: '2026-08-26 12:43:28.047' },
        spm: '0.0.form.field',
        scm: '',
      },
    ];
    const gokey = encodeURIComponent(`expdata=${JSON.stringify(expdata)}&tlver=2.11.48&spm-url=`);
    const event = parseAplusRequest(
      `https://wgo.mmstat.com/demo.exposure.combo?gmkey=EXP&gokey=${gokey}`,
    );

    expect(event).toMatchObject({
      event_type: 'EXP',
      name: '0.0.form.field',
      _raw: {
        expdata: [
          {
            exargs: {
              bizArgs: {
                order_id: 'demo-order-2',
                collect_type: null,
                field_type: 'ITEM',
              },
              log_time: '2026-08-26 12:43:28.047',
            },
          },
        ],
      },
    });
  });

  it('extracts direct gokey bizArgs as structured event data', () => {
    const bizArgs = encodeURIComponent(JSON.stringify({ order_id: 'demo-order-2' }));
    const gokey = encodeURIComponent(`spm=1.2.button.submit&bizArgs=${bizArgs}`);
    const event = parseAplusRequest(`https://gm.mmstat.com/aplus.clk?gmkey=CLK&gokey=${gokey}`);

    expect(event?._raw.bizArgs).toEqual({ order_id: 'demo-order-2' });
  });

  it('preserves literal plus signs in top-level tracking parameters', () => {
    const expdata = [{ spm: '1.2.titlebar.back', scm: '' }];
    const gokey = encodeURIComponent(`expdata=${encodeURIComponent(JSON.stringify(expdata))}`);
    const event = parseAplusRequest(
      `https://wgo.mmstat.com/demo.exposure.combo?gmkey=EXP&gokey=${gokey}&cna=test/value+suffix`,
    );

    expect(event).toMatchObject({
      source: 'aplus',
      event_type: 'EXP',
      name: '1.2.titlebar.back',
    });
    expect(event?._raw.cna).toBe('test/value+suffix');
  });

  it('classifies selfdefine paths as SDF and names them from the path', () => {
    const event = parseAplusRequest('https://gm.mmstat.com/aplus.selfdefine.myEvent?gmkey=OTHER');
    expect(event).toMatchObject({
      source: 'aplus',
      event_type: 'SDF',
      name: 'selfdefine.myEvent',
    });
  });

  it('uses spm-url as the PV event name', () => {
    const gokey = encodeURIComponent('spm-url=1.2.page.index');
    const event = parseAplusRequest(`https://gm.mmstat.com/aplus.pv?gmkey=PV&gokey=${gokey}`);
    expect(event?.name).toBe('1.2.page.index');
  });

  it('decodes nested gokey values before resolving the PV event name and page URL', () => {
    const nestedSpmUrl = encodeURIComponent('https://example.com/page?foo=bar&spm=1.2.page.index');
    const nestedPageUrl = encodeURIComponent('https://example.com/page?from=aplus');
    const gokey = encodeURIComponent(`spm-url=${nestedSpmUrl}&_p_url=${nestedPageUrl}`);
    const event = parseAplusRequest(`https://gm.mmstat.com/aplus.pv?gmkey=PV&gokey=${gokey}`);

    expect(event?.name).toBe('1.2.page.index');
    expect(event?._context.view.page_url).toBe('https://example.com/page?from=aplus');
  });
});

describe('parseRumRequest', () => {
  it('parses every event in a RUM request body with a shared batch id', () => {
    const events = parseRumRequest(
      'https://demo.rum.aliyuncs.com/report',
      JSON.stringify({
        app: { id: 'app-1' },
        events: [
          { event_id: 'view-1', event_type: 'view', name: 'home', timestamp: 100 },
          { event_id: 'xhr-1', event_type: 'resource', type: 'xhr', duration: 20 },
        ],
      }),
      { now: 1700000000000, sequence: 9 },
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: '9-view-1',
      batchId: 9,
      source: 'rum',
      event_type: 'view',
      name: 'home',
    });
    expect(events[1]).toMatchObject({
      id: '9-xhr-1',
      type: 'xhr',
      duration: 20,
    });
    expect(events[0]._context.app).toEqual({ id: 'app-1' });
  });

  it('converts i18n tracker custom events into aplus-style events', () => {
    const [event] = parseRumRequest(
      'https://demo.rum.aliyuncs.com/report',
      {
        events: [
          {
            event_type: 'action',
            type: 'cst',
            snapshots: JSON.stringify({
              message: 'i18n-tracker-clk',
              c1: '1.2',
              c2: 'button.submit',
            }),
          },
        ],
      },
      { sequence: 2 },
    );

    expect(event).toMatchObject({
      source: 'rum',
      event_type: 'CLK',
      name: '1.2.button.submit',
      type: 'custom',
    });
    expect(event._raw.expdata[0].spm).toBe('1.2.button.submit');
  });

  it('returns no events for invalid bodies', () => {
    expect(parseRumRequest('https://demo.rum.aliyuncs.com/report', 'not-json')).toEqual([]);
  });

  it('skips malformed entries without dropping valid events from the same batch', () => {
    const events = parseRumRequest('https://demo.rum.aliyuncs.com/report', {
      events: [null, 'invalid', { event_type: 'view', name: 'valid' }],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: expect.stringMatching(/-2$/),
      event_type: 'view',
      name: 'valid',
    });
  });
});

describe('parseArmsRequest', () => {
  it('returns null for a non-arms url', () => {
    expect(parseArmsRequest('https://example.com/x')).toBeNull();
  });

  it('parses an arms report into a RumEvent', () => {
    const event = parseArmsRequest(
      'https://arms-retcode.aliyuncs.com/r.png?t=res&page=Home&pid=myapp&begin=1600000000000&uid=u1&sid=s1',
    );
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      source: 'arms',
      event_type: 'res',
      name: 'Home',
      timestamp: 1600000000000,
    });
    expect(event?._context.app.pid).toBe('myapp');
    expect(event?._context.user.uid).toBe('u1');
    expect(event?._context.session.sid).toBe('s1');
  });

  it('lowercases the event type', () => {
    const event = parseArmsRequest('https://arms-retcode.aliyuncs.com/r.png?t=API&page=P');
    expect(event?.event_type).toBe('api');
  });
});

describe('parseTrackingRequest', () => {
  it('dispatches to the matching parser', () => {
    const events = parseTrackingRequest(
      'https://demo.rum.aliyuncs.com/report',
      JSON.stringify({ events: [{ event_type: 'view' }] }),
      { sequence: 3 },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'rum', batchId: 3 });
  });
});

describe('tracking host boundaries', () => {
  it.each([
    'https://example.com/api?target=https://gm.mmstat.com/aplus.clk&gmkey=CLK',
    'https://example.com/path/demo.rum.aliyuncs.com/report',
    'https://gm.mmstat.com.evil.example/aplus.clk?gmkey=CLK',
    'https://notarms-retcode.aliyuncs.com/r.png?t=api',
    'https://example.com/api?target=https://arms-retcode.aliyuncs.com/r.png',
    'https://example.com/api?target=https://beacon.taobao.com/b',
    'file://gm.mmstat.com/aplus.clk',
  ])('does not consume a non-tracking request: %s', url => {
    expect(isTrackingUrl(url)).toBe(false);
    expect(parseTrackingRequest(url, { events: [{ event_type: 'view' }] })).toEqual([]);
  });
});
