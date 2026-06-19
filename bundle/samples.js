/**
 * Bundled sample corpora so a judge with nothing to paste still sees the full
 * arc in one click. The "nginx" set is the canonical demo: 15 lines, 14 with a
 * dot before the milliseconds and ONE (index 8) with a comma — so a first
 * timestamp pattern scores 14/15, and widening `\.` to `[.,]` snaps it to 15/15.
 */
export const SAMPLES = [
  {
    id: "nginx",
    label: "app log",
    intent: "Extract the ISO timestamp, the log level, and the UUID request id.",
    lines: [
      "2026-06-16T09:21:03.114Z INFO  req=550e8400-e29b-41d4-a716-446655440000 GET /api/v1/users 200 14ms",
      "2026-06-16T09:21:03.290Z WARN  req=7c9e6679-7425-40de-944b-e07fc1f90ae7 GET /api/v1/orders 200 31ms",
      "2026-06-16T09:21:04.001Z ERROR req=16fd2706-8baf-433b-82eb-8c7fada847da POST /api/v1/pay 500 88ms",
      "2026-06-16T09:21:04.512Z INFO  req=9b2e4f1a-1c3d-4e5f-8a9b-0c1d2e3f4a5b GET /api/v1/items 200 9ms",
      "2026-06-16T09:21:05.077Z DEBUG req=a1b2c3d4-e5f6-7890-abcd-ef0123456789 GET /healthz 200 1ms",
      "2026-06-16T09:21:05.349Z INFO  req=3f2504e0-4f89-41d3-9a0c-0305e82c3301 GET /api/v1/cart 200 12ms",
      "2026-06-16T09:21:06.220Z WARN  req=2c1743a3-9c5b-4e62-9b91-1c0c9b5a77aa GET /api/v1/feed 200 47ms",
      "2026-06-16T09:21:06.808Z INFO  req=f47ac10b-58cc-4372-a567-0e02b2c3d479 GET /api/v1/users 200 8ms",
      "2026-06-16T09:21:07,250Z INFO  req=6ba7b810-9dad-11d1-80b4-00c04fd430c8 GET /api/v1/cart 200 11ms",
      "2026-06-16T09:21:07.640Z ERROR req=6ba7b811-9dad-11d1-80b4-00c04fd430c8 POST /api/v1/pay 502 120ms",
      "2026-06-16T09:21:08.133Z INFO  req=00112233-4455-6677-8899-aabbccddeeff GET /api/v1/items 200 7ms",
      "2026-06-16T09:21:08.910Z DEBUG req=12345678-1234-5678-1234-567812345678 GET /healthz 200 1ms",
      "2026-06-16T09:21:09.402Z WARN  req=87654321-4321-8765-4321-876543218765 GET /api/v1/feed 200 39ms",
      "2026-06-16T09:21:09.998Z INFO  req=fedcba98-7654-3210-fedc-ba9876543210 GET /api/v1/users 200 6ms",
      "2026-06-16T09:21:10.530Z INFO  req=0f0e0d0c-0b0a-0908-0706-050403020100 GET /api/v1/orders 200 10ms",
    ],
  },
  {
    id: "json",
    label: "json logs",
    intent: "Pull the timestamp, the level, and the latency in ms.",
    lines: [
      '{"ts":"2026-06-16T09:21:03Z","level":"info","msg":"request ok","latency_ms":14}',
      '{"ts":"2026-06-16T09:21:03Z","level":"warn","msg":"slow upstream","latency_ms":231}',
      '{"ts":"2026-06-16T09:21:04Z","level":"error","msg":"payment failed","latency_ms":88}',
      '{"ts":"2026-06-16T09:21:04Z","level":"info","msg":"cache hit","latency_ms":2}',
      '{"ts":"2026-06-16T09:21:05Z","level":"info","msg":"request ok","latency_ms":9}',
      '{"ts":"2026-06-16T09:21:05Z","level":"debug","msg":"healthz","latency_ms":1}',
      '{"ts":"2026-06-16T09:21:06Z","level":"warn","msg":"retry","latency_ms":47}',
      '{"ts":"2026-06-16T09:21:06Z","level":"info","msg":"request ok","latency_ms":8}',
      '{"ts":"2026-06-16T09:21:07Z","level":"error","msg":"upstream 502","latency_ms":120}',
      '{"ts":"2026-06-16T09:21:07Z","level":"info","msg":"request ok","latency_ms":11}',
    ],
  },
  {
    id: "csv",
    label: "csv rows",
    intent: "Capture the order date, the SKU, and the dollar amount.",
    lines: [
      "2026-06-16,ACME-1042,Widget,3,$59.97",
      "2026-06-16,ACME-2231,Gadget,1,$19.99",
      "2026-06-15,ACME-0007,Sprocket,12,$144.00",
      "2026-06-15,ACME-1042,Widget,2,$39.98",
      "2026-06-14,ACME-9100,Cog,5,$5.25",
      "2026-06-14,ACME-2231,Gadget,4,$79.96",
      "2026-06-13,ACME-0007,Sprocket,1,$12.00",
      "2026-06-13,ACME-3050,Bearing,20,$240.00",
      "2026-06-12,ACME-1042,Widget,7,$139.93",
      "2026-06-12,ACME-9100,Cog,2,$2.10",
    ],
  },
];

export const DEFAULT_SAMPLE = "nginx";
