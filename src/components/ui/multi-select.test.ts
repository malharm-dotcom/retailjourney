// The dropdown's whole contract with the GET forms: one real, named checkbox
// per option, pre-ticked from the URL, so a submit sends ?name=A&name=B.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MultiSelect } from "./multi-select";

describe("MultiSelect", () => {
  const html = renderToStaticMarkup(
    createElement(MultiSelect, { name: "courier", options: ["BLUEDART", "MOVEMATE", { value: "—", label: "No courier yet" }], defaultValue: ["BLUEDART", "MOVEMATE"] }),
  );

  it("renders a named checkbox for every option", () => {
    expect(html.match(/type="checkbox" name="courier"/g)).toHaveLength(3);
  });

  it("pre-ticks exactly the values from the URL and summarises them", () => {
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain("2 selected");
  });

  it("reads 'All' when nothing is ticked", () => {
    expect(renderToStaticMarkup(createElement(MultiSelect, { name: "lane", options: ["NCR"] }))).toContain(">All<");
  });
});
