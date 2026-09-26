import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { runCli } from "../quote-stock-token-route/scripts/quote-agent.mjs";

const SCRIPT = fileURLToPath(
  new URL(
    "../quote-stock-token-route/scripts/quote-agent.mjs",
    import.meta.url,
  ),
);
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const AMZN = "0x12f190a9F9d7D37a250758b26824B97CE941bF54";
const NO_HOOK = `0x${"0".repeat(40)}`;
const ROUTE = "https://api.perkos.xyz/desks/stocks-robinhood/quote";
const QUOTE_URL = `${ROUTE}?ticker=AMZN&amountIn=100000000`;
const NOT_USDG = /the input token is not USDG \(0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168\) with 6 decimals/;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routeToken(symbol, address, decimals) {
  return { chainId: 4663, symbol, address, decimals: String(decimals) };
}

function quoteBody(overrides = {}) {
  return {
    chainId: 4663,
    ticker: "AMZN",
    tokenIn: { symbol: "USDG", address: USDG, decimals: 6 },
    tokenOut: { symbol: "AMZN", address: AMZN, decimals: 18 },
    amountIn: "100000000",
    amountOut: "400000000000000000",
    priceImpactPct: 0.42,
    routing: "CLASSIC",
    protocols: ["V4"],
    route: [
      [
        {
          type: "v4-pool",
          address: `0x${"ab".repeat(32)}`,
          tokenIn: routeToken("USDG", USDG, 6),
          tokenOut: routeToken("AMZN", AMZN, 18),
          fee: "3000",
          tickSpacing: "60",
          hooks: NO_HOOK,
          amountIn: "100000000",
          amountOut: "400000000000000000",
        },
      ],
    ],
    gasFeeUsd: "0.0123",
    requestId: "quote-request-one",
    quotedAt: "2026-09-26T12:00:00.000Z",
    attribution: { decisionOrigin: "autonomous", status: null },
    ...overrides,
  };
}

// Answers every request with the fake desk quote and records the calls.
function fakeDesk({ quote = () => jsonResponse(quoteBody()) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return quote();
  };
  return { calls, fetchImpl };
}

function neverFetch() {
  throw new Error("request should not be sent");
}

async function quoteOutput(desk, argv = ["quote", "AMZN", "100000000"]) {
  const output = [];
  await runCli({
    argv,
    env: {},
    fetchImpl: desk.fetchImpl,
    write: (value) => output.push(value),
  });
  return JSON.parse(output[0]);
}

const refusesQuote = (fetchImpl, expected, env = {}) =>
  assert.rejects(
    runCli({
      argv: ["quote", "AMZN", "100000000"],
      env,
      fetchImpl,
      write: () => {
        throw new Error("nothing should be printed");
      },
    }),
    expected,
  );

test("reports the executable price, route and protocols for a quote", async () => {
  const desk = fakeDesk();
  const result = await quoteOutput(desk, ["quote", "amzn", "100000000"]);

  assert.deepEqual(
    desk.calls.map((call) => call.url),
    [QUOTE_URL],
  );
  assert.equal(desk.calls[0].init.headers.accept, "application/json");
  assert.equal(result.chainId, 4663);
  assert.equal(result.ticker, "AMZN");
  assert.equal(result.requestId, "quote-request-one");
  assert.equal(result.quotedAt, "2026-09-26T12:00:00.000Z");
  assert.deepEqual(result.pay, {
    amount: "100",
    symbol: "USDG",
    atomic: "100000000",
    token: USDG,
  });
  assert.deepEqual(result.receive, {
    amount: "0.4",
    symbol: "AMZN",
    atomic: "400000000000000000",
    token: AMZN,
    decimals: 18,
  });
  assert.deepEqual(result.executablePrice, { usdgPerToken: "250" });
  assert.equal(result.priceImpactPct, 0.42);
  assert.equal(result.gasFeeUsd, "0.0123");
  assert.equal(result.routing.type, "CLASSIC");
  assert.equal(result.routing.documented, true);
  assert.deepEqual(result.route, {
    paths: [
      {
        sharePct: 100,
        hops: [
          {
            protocol: "V4",
            pool: `0x${"ab".repeat(32)}`,
            tokenIn: "USDG",
            tokenOut: "AMZN",
            feePct: "0.3",
            tickSpacing: "60",
            hooks: NO_HOOK,
          },
        ],
      },
    ],
    protocolsUsed: ["V4"],
  });
  assert.deepEqual(result.protocols, {
    considered: ["V4"],
    excluded: ["V2", "V3", "UNISWAPX"],
  });
  assert.equal(result.reference, undefined);
  assert.deepEqual(result.attribution, {
    decisionOrigin: "autonomous",
    status: null,
  });
  assert.deepEqual(result.gaps, []);
  assert.match(result.notice, /nothing was signed, deployed or submitted/);
});

test("never sends a session or a credential and never prints calldata", async () => {
  const desk = fakeDesk({
    quote: () =>
      jsonResponse(
        quoteBody({
          swapTransaction: { to: USDG, data: "0xdeadbeef" },
          permitData: { domain: {} },
        }),
      ),
  });
  const output = [];
  await runCli({
    argv: ["quote", "AMZN", "100000000"],
    env: { PERKOS_SESSION: "session=test-only" },
    fetchImpl: desk.fetchImpl,
    write: (value) => output.push(value),
  });

  for (const call of desk.calls) {
    assert.deepEqual(Object.keys(call.init.headers), ["accept"]);
    assert.equal(call.init.method, undefined);
  }
  assert.doesNotMatch(output[0], /deadbeef|swapTransaction|permitData/);
});

test("summarizes a split route and states what the desk left out", async () => {
  const desk = fakeDesk({
    quote: () =>
      jsonResponse(
        quoteBody({
          priceImpactPct: null,
          gasFeeUsd: null,
          routing: "V4",
          protocols: [],
          attribution: { decisionOrigin: "autonomous", status: "malformed" },
          route: [
            [
              {
                type: "v4-pool",
                address: `0x${"ab".repeat(32)}`,
                tokenIn: routeToken("USDG", USDG, 6),
                tokenOut: routeToken("AMZN", AMZN, 18),
                fee: "500",
                tickSpacing: "10",
                hooks: `0x${"cd".repeat(20)}`,
                amountIn: "60000000",
              },
            ],
            [
              {
                type: "v3-pool",
                address: `0x${"33".repeat(20)}`,
                tokenIn: routeToken("USDG", USDG, 6),
                tokenOut: routeToken("WETH", `0x${"44".repeat(20)}`, 18),
                fee: "10000",
                amountIn: "40000000",
              },
              {
                type: "v2-pool",
                address: `0x${"55".repeat(20)}`,
                tokenIn: routeToken("WETH", `0x${"44".repeat(20)}`, 18),
                tokenOut: routeToken("AMZN", AMZN, 18),
              },
            ],
          ],
        }),
      ),
  });
  const result = await quoteOutput(desk);

  assert.deepEqual(
    result.route.paths.map((path) => path.sharePct),
    [60, 40],
  );
  assert.deepEqual(result.route.paths[0].hops[0].feePct, "0.05");
  assert.deepEqual(result.route.paths[0].hops[0].hooks, `0x${"cd".repeat(20)}`);
  assert.deepEqual(result.route.paths[1].hops, [
    {
      protocol: "V3",
      pool: `0x${"33".repeat(20)}`,
      tokenIn: "USDG",
      tokenOut: "WETH",
      feePct: "1",
    },
    {
      protocol: "V2",
      pool: `0x${"55".repeat(20)}`,
      tokenIn: "WETH",
      tokenOut: "AMZN",
      feePct: "0.3",
    },
  ]);
  assert.deepEqual(result.route.protocolsUsed, ["V4", "V3", "V2"]);
  assert.equal(result.priceImpactPct, null);
  assert.equal(result.gasFeeUsd, null);
  assert.deepEqual(result.routing, {
    type: "V4",
    settles: null,
    documented: false,
  });
  assert.deepEqual(result.protocols, { considered: null, excluded: null });
  assert.deepEqual(result.gaps, [
    "The desk did not report the price impact at this size.",
    "The desk did not report a gas estimate.",
    'Routing "V4" is not a documented Uniswap API routing value.',
    "The desk did not report which protocols the quote considered, " +
      "so the excluded protocols are unknown.",
    "Uniswap dropped the X-Agent-Info header as malformed.",
  ]);
});

test("states a routing the desk did not report", async () => {
  const result = await quoteOutput(
    fakeDesk({ quote: () => jsonResponse(quoteBody({ routing: null })) }),
  );

  assert.deepEqual(result.routing, {
    type: null,
    settles: null,
    documented: false,
  });
  assert.deepEqual(result.gaps, [
    "The desk did not report the routing type.",
  ]);
});

test("explains an empty route on a UniswapX quote", async () => {
  const desk = fakeDesk({
    quote: () =>
      jsonResponse(
        quoteBody({
          routing: "DUTCH_V3",
          protocols: ["V4", "UNISWAPX_V3"],
          route: [],
        }),
      ),
  });
  const result = await quoteOutput(desk);

  assert.equal(result.routing.documented, true);
  assert.match(result.routing.settles, /UniswapX signed order/);
  assert.deepEqual(result.route, { paths: [], protocolsUsed: [] });
  assert.deepEqual(result.protocols.excluded, ["V2", "V3"]);
  assert.deepEqual(result.gaps, [
    "UniswapX quotes carry no pool-by-pool route.",
  ]);
});

test("states an empty route on an AMM quote as missing detail", async () => {
  for (const route of [[], undefined]) {
    const result = await quoteOutput(
      fakeDesk({ quote: () => jsonResponse(quoteBody({ route })) }),
    );

    assert.equal(result.routing.type, "CLASSIC");
    assert.deepEqual(result.route, { paths: [], protocolsUsed: [] });
    assert.deepEqual(result.gaps, ["The desk returned no route detail."]);
  }
});

test("states a quote with no timestamp", async () => {
  for (const quotedAt of [undefined, null, ""]) {
    const result = await quoteOutput(
      fakeDesk({ quote: () => jsonResponse(quoteBody({ quotedAt })) }),
    );

    assert.equal(result.quotedAt, null);
    assert.deepEqual(result.gaps, ["The quote has no timestamp."]);
  }
});

test("reports a fee it cannot read as null", async () => {
  const hop = quoteBody().route[0][0];
  const result = await quoteOutput(
    fakeDesk({
      quote: () =>
        jsonResponse(quoteBody({ route: [[{ ...hop, fee: "1000001" }]] })),
    }),
  );

  assert.equal(result.route.paths[0].hops[0].feePct, null);
});

test("uses PERKOS_DESK_QUOTE_URL as the full quote route", async () => {
  const cases = [
    [
      "http://desk.internal:8090/quote",
      "http://desk.internal:8090/quote?ticker=AMZN&amountIn=1000000",
    ],
    [
      "https://api.example/desks/stocks-robinhood/quote?ticker=NVDA",
      "https://api.example/desks/stocks-robinhood/quote?ticker=AMZN&amountIn=1000000",
    ],
  ];
  for (const [configured, expected] of cases) {
    const calls = [];
    await runCli({
      argv: ["quote", "AMZN", "1000000"],
      env: { PERKOS_DESK_QUOTE_URL: configured },
      fetchImpl: async (url) => {
        calls.push(url);
        return jsonResponse(quoteBody({ amountIn: "1000000" }));
      },
      write: () => {},
    });

    assert.deepEqual(calls, [expected]);
  }
});

test("refuses malformed input before sending any request", async () => {
  const cases = [
    ["quote"],
    ["quote", "AMZN"],
    ["quote", "AMZN", "0"],
    ["quote", "AMZN", "1.5"],
    ["quote", "AMZN", "-100"],
    ["quote", "AM ZN", "1000000"],
    ["quote", "AMZN", "1000000", "extra"],
    ["catalog", "AMZN"],
    ["unknown"],
  ];
  for (const argv of cases) {
    await assert.rejects(
      runCli({ argv, env: {}, fetchImpl: neverFetch }),
      /Usage:/,
      argv.join(" "),
    );
  }
});

test("has no execution mode", async () => {
  await assert.rejects(
    runCli({
      argv: ["quote", "AMZN", "1000000", "--execute"],
      env: {},
      fetchImpl: neverFetch,
    }),
    /only reads quotes\. It has no flags and no execution mode/,
  );
});

test("refuses a quote URL that is not http or not a URL", async () => {
  await refusesQuote(neverFetch, /PERKOS_DESK_QUOTE_URL must use http or https/, {
    PERKOS_DESK_QUOTE_URL: "file:///etc/hosts",
  });
  await refusesQuote(neverFetch, /PERKOS_DESK_QUOTE_URL is not a valid URL/, {
    PERKOS_DESK_QUOTE_URL: "not a url",
  });
});

test("explains each error status the desk or PerkOS answers", async () => {
  const cases = [
    [
      400,
      {
        error: "invalid_amount",
        message: "amountIn must be a positive whole number of atomic USDG",
      },
      new RegExp(
        "desk rejected the quote request \\(400 invalid_amount: amountIn " +
          "must be a positive whole number of atomic USDG\\)",
      ),
    ],
    [
      400,
      {
        error: "invalid_module",
        message: "module must be a desk module such as stocks-robinhood",
      },
      new RegExp(
        "PerkOS does not know the desk named in the quote URL \\(400 invalid_module: " +
          "module must be a desk module such as stocks-robinhood\\)\\. " +
          "Check PERKOS_DESK_QUOTE_URL\\. There is no executable price",
      ),
    ],
    [
      404,
      { error: "unknown_module", message: "There is no desk stocks-robinhood" },
      new RegExp(
        "PerkOS does not know the desk named in the quote URL \\(404 unknown_module: " +
          "There is no desk stocks-robinhood\\)\\. Check PERKOS_DESK_QUOTE_URL",
      ),
    ],
    [
      404,
      {
        error: "not_uniswap_routable",
        message: "AMZN has no observed Uniswap route",
      },
      new RegExp(
        "No executable quote for AMZN \\(404 not_uniswap_routable: AMZN has " +
          "no observed Uniswap route\\)\\. Do not substitute another asset",
      ),
    ],
    [
      404,
      { error: "not_found" },
      /There is no desk quote route at https:\/\/api\.perkos\.xyz\/desks\/stocks-robinhood\/quote \(404 not_found\)/,
    ],
    [
      502,
      { error: "uniswap_quote_failed", message: "The Uniswap quote failed" },
      new RegExp(
        "unavailable upstream \\(502 uniswap_quote_failed: The Uniswap " +
          "quote failed\\)\\. There is no executable price",
      ),
    ],
    [
      502,
      {
        error: "uniswap_quote_failed",
        message: "Uniswap quote failed with status 404",
      },
      new RegExp(
        "Uniswap returned no quote for AMZN \\(502 uniswap_quote_failed: " +
          "Uniswap quote failed with status 404\\)\\. The desk does not pass " +
          "on the Uniswap error code, so the cause is unknown\\. There is no " +
          "executable price\\. Do not substitute another asset\\.",
      ),
    ],
    [
      502,
      {
        error: "uniswap_quote_failed",
        message: "Uniswap quote failed with status 429",
      },
      new RegExp(
        "unavailable upstream \\(502 uniswap_quote_failed: Uniswap quote " +
          "failed with status 429\\)\\. There is no executable price",
      ),
    ],
    [
      502,
      {
        error: "catalog_unavailable",
        message: "The stock catalog is unavailable",
      },
      /unavailable upstream \(502 catalog_unavailable: The stock catalog is unavailable\)/,
    ],
    [
      503,
      {
        error: "quote_unavailable",
        message: "Uniswap quoting is not configured on this server",
      },
      /unavailable upstream \(503 quote_unavailable: Uniswap quoting is not configured on this server\)/,
    ],
    [
      503,
      {
        error: "desk_unavailable",
        message: "The stocks-robinhood desk is not answering. Try again in a moment.",
      },
      new RegExp(
        "The desk is not answering through PerkOS \\(503 desk_unavailable: " +
          "The stocks-robinhood desk is not answering\\. Try again in a " +
          "moment\\.\\)\\. There is no executable price right now\\. Ask " +
          "again later, and do not retry in a loop\\.",
      ),
    ],
    [
      500,
      { error: "internal_error" },
      /quote request failed \(500 internal_error\)\. There is no executable price/,
    ],
    [
      500,
      { error: { message: "internal server error" } },
      /quote request failed \(500 internal server error\)/,
    ],
    [
      401,
      { error: { code: "UNAUTHORIZED", message: "missing session" } },
      /quote request failed \(401 UNAUTHORIZED: missing session\)/,
    ],
  ];
  for (const [status, body, expected] of cases) {
    const desk = fakeDesk({ quote: () => jsonResponse(body, status) });
    await refusesQuote(desk.fetchImpl, expected);
    assert.equal(desk.calls.length, 1, `one request, no retry after ${status}`);
  }
});

test("explains a missing quote route, as when it is not deployed yet", async () => {
  const desk = fakeDesk({
    quote: () =>
      new Response("404 Not Found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=UTF-8" },
      }),
  });
  await refusesQuote(
    desk.fetchImpl,
    new RegExp(
      "There is no desk quote route at https://api\\.perkos\\.xyz/desks/" +
        "stocks-robinhood/quote \\(404, and the answer is not JSON\\)\\. The " +
        "route may not be deployed on PerkOS yet, or PERKOS_DESK_QUOTE_URL " +
        "is wrong\\. There is no executable price\\. Do not retry in a loop\\.",
    ),
  );
  assert.equal(desk.calls.length, 1, "one request, no retry");
});

test("asks to wait on a 429 instead of retrying", async () => {
  const limited = (retryAfter, message = "Too many new quotes on this server; retry in 7 seconds") =>
    fakeDesk({
      quote: () =>
        new Response(
          JSON.stringify({ error: "rate_limited", message }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              ...(retryAfter ? { "retry-after": retryAfter } : {}),
            },
          },
        ),
    });
  const withHeader = limited("7");
  await refusesQuote(
    withHeader.fetchImpl,
    new RegExp(
      "limiting new quotes \\(429 rate_limited: Too many new quotes on this " +
        "server; retry in 7 seconds\\)\\. Wait 7 seconds before asking " +
        "again, and do not retry in a loop\\.",
    ),
  );
  assert.equal(withHeader.calls.length, 1, "one request, no retry");
  const withoutHeader = limited(null);
  await refusesQuote(
    withoutHeader.fetchImpl,
    /Wait the time the server asks for before asking again/,
  );
  const byPerkos = limited("30", "Too many quotes; retry in 30 seconds");
  await refusesQuote(
    byPerkos.fetchImpl,
    new RegExp(
      "PerkOS or the desk is limiting new quotes \\(429 rate_limited: Too many " +
        "quotes; retry in 30 seconds\\)\\. Wait 30 seconds before asking again",
    ),
  );
  assert.equal(byPerkos.calls.length, 1, "one request, no retry");
});

test("reports an unreachable route, an unreadable answer and a non-JSON answer", async () => {
  const unreachable = async () => {
    throw new TypeError("fetch failed");
  };
  await refusesQuote(
    unreachable,
    new RegExp(`Could not reach the desk quote route at ${ROUTE.replace(/\./g, "\\.")}: fetch failed`),
  );
  const unreadable = {
    status: 200,
    ok: true,
    headers: new Headers(),
    text: async () => {
      throw new Error("The operation was aborted due to timeout");
    },
  };
  await refusesQuote(
    async () => unreadable,
    /Could not read the answer from the desk quote route at .*: The operation was aborted due to timeout/,
  );
  await refusesQuote(
    async () => new Response("<html>bad gateway</html>", { status: 502 }),
    /returned a non-JSON response \(502\)\. There is no executable price/,
  );
});

test("refuses a quote that does not match the request", async () => {
  const cases = [
    [{ chainId: 1 }, /it is for chain 1, not Robinhood Chain 4663/],
    [{ ticker: "NVDA" }, /it prices NVDA, not AMZN/],
    [{ amountIn: "1000000" }, /it prices 1000000 atomic USDG, not the requested 100000000/],
    [{ tokenIn: { symbol: "USDC", address: USDG, decimals: 6 } }, NOT_USDG],
    [{ tokenIn: { symbol: "USDG", address: USDG, decimals: 18 } }, NOT_USDG],
    [{ tokenIn: { symbol: "USDG", address: `0x${"77".repeat(20)}`, decimals: 6 } }, NOT_USDG],
    [{ tokenIn: { symbol: "USDG", decimals: 6 } }, NOT_USDG],
    [
      { tokenOut: { symbol: "AMZN", address: AMZN } },
      /the output token address or decimals are missing/,
    ],
    [
      { tokenOut: { symbol: "AMZN", address: "0x1234", decimals: 18 } },
      /the output token address or decimals are missing/,
    ],
    [{ amountOut: "0" }, /it has no executable output amount/],
    [{ amountOut: undefined }, /it has no executable output amount/],
    [{ requestId: "" }, /it has no Uniswap request id to record/],
    [{ requestId: null }, /it has no Uniswap request id to record/],
    [{ requestId: undefined }, /it has no Uniswap request id to record/],
  ];
  for (const [overrides, expected] of cases) {
    const desk = fakeDesk({ quote: () => jsonResponse(quoteBody(overrides)) });
    await refusesQuote(desk.fetchImpl, expected);
  }
});

test("reports the token address the desk priced, as the desk gave it", async () => {
  const other = `0x${"99".repeat(20)}`;
  const result = await quoteOutput(
    fakeDesk({
      quote: () =>
        jsonResponse(
          quoteBody({ tokenOut: { symbol: "AMZN", address: other, decimals: 18 } }),
        ),
    }),
  );

  assert.equal(result.receive.token, other);
  assert.deepEqual(result.gaps, []);
});

test("refuses a successful answer that is not a quote object", async () => {
  for (const body of [[], null, "quote"]) {
    const desk = fakeDesk({ quote: () => jsonResponse(body) });
    await refusesQuote(
      desk.fetchImpl,
      /Refusing the quote: the desk returned no quote/,
    );
    assert.equal(desk.calls.length, 1, JSON.stringify(body));
  }
});

test("accepts the USDG address in any letter case", async () => {
  const desk = fakeDesk({
    quote: () =>
      jsonResponse(
        quoteBody({
          tokenIn: { symbol: "USDG", address: USDG.toLowerCase(), decimals: 6 },
        }),
      ),
  });
  const result = await quoteOutput(desk);

  assert.equal(result.pay.token, USDG.toLowerCase());
  assert.deepEqual(result.gaps, []);
});

test("states a missing X-Agent-Info attribution", async () => {
  for (const attribution of [undefined, null]) {
    const desk = fakeDesk({
      quote: () => jsonResponse(quoteBody({ attribution })),
    });
    const result = await quoteOutput(desk);

    assert.equal(result.attribution, null);
    assert.deepEqual(result.gaps, [
      "The desk did not report the X-Agent-Info attribution.",
    ]);
  }
});

test("accepts the same ticker shape as the desk", async () => {
  const accepted = [
    ["a.b-c", "A.B-C"],
    ["ABCDEFGHIJKL", "ABCDEFGHIJKL"],
  ];
  for (const [input, sent] of accepted) {
    const desk = fakeDesk({
      quote: () =>
        jsonResponse(
          { error: "asset_not_found", message: `${sent} is not listed` },
          404,
        ),
    });
    await assert.rejects(
      runCli({
        argv: ["quote", input, "1000000"],
        env: {},
        fetchImpl: desk.fetchImpl,
      }),
      new RegExp(`No executable quote for ${sent.replace(/\./g, "\\.")} \\(404 asset_not_found`),
    );
    assert.equal(desk.calls[0].url, `${ROUTE}?ticker=${sent}&amountIn=1000000`);
  }
  for (const ticker of ["ABCDEFGHIJKLM", "1ABC", "-ABC", ".ABC"]) {
    await assert.rejects(
      runCli({ argv: ["quote", ticker, "1000000"], env: {}, fetchImpl: neverFetch }),
      /Usage:/,
      ticker,
    );
  }
});

test("prints usage with an example within the desk's default limit", async () => {
  const output = [];
  await runCli({ argv: ["help"], env: {}, fetchImpl: neverFetch, write: (value) => output.push(value) });

  assert.match(output[0], /100 USDG is 100000000/);
  assert.match(output[0], /PERKOS_DESK_QUOTE_URL/);
  assert.match(output[0], /never builds calldata, signs, deploys or submits anything/);
  assert.doesNotMatch(output[0], /catalog/);
});

test("runs through a symlinked path to the script", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "quote-agent-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "quote-agent.mjs");
  symlinkSync(SCRIPT, link);

  const help = spawnSync(process.execPath, [link, "help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /quote-agent\.mjs quote <ticker> <atomic-usdg>/);

  const failed = spawnSync(process.execPath, [link, "quote", "AMZN"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /Usage:/);
});

test("does not run when another program imports it", () => {
  const imported = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`,
      join(tmpdir(), "quote-agent-missing", "caller.mjs"),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");
});

test("exits with code 1 and a message on stderr when run directly", () => {
  const failed = spawnSync(process.execPath, [SCRIPT, "quote", "AMZN"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /Usage:/);

  const help = spawnSync(process.execPath, [SCRIPT, "help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /quote-agent\.mjs quote <ticker> <atomic-usdg>/);
});
