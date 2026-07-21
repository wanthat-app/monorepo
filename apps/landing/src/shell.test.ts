import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Tripwire for the shell template (prod incident 2026-07-21): Vite injects the built asset
 * tags before the FIRST `</head>` in this file, and the landing Lambda's injection keys on
 * `<title>` / `</head>` / `<div id="root"></div>` — an HTML comment that merely MENTIONS any
 * of those tokens captures the injections and the served page renders as one giant comment.
 * The template must stay comment-free and single-anchored.
 */
describe("landing.html shell template", () => {
  const shell = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "landing.html"),
    "utf8",
  );

  it("contains no HTML comments", () => {
    expect(shell).not.toContain("<!--");
  });

  it("has exactly one </head>, one <title>, and the empty root div", () => {
    expect(shell.match(/<\/head>/g)).toHaveLength(1);
    expect(shell.match(/<title>/g)).toHaveLength(1);
    expect(shell).toContain('<div id="root"></div>');
  });
});
