// Step definitions for bounded preprocessing: the parse5 frontend and its
// input limits, which apply BEFORE the policy sees a tree.
//
// These steps deliberately build hostile inputs in code rather than in a
// docstring: a scenario should read as the shape of the attack ("5,000 nested
// elements"), not as 55,001 characters of markup.
//
// Preprocessing is a property of this JavaScript frontend, not of checker
// semantics, so these scenarios do not claim cross-engine agreement. The Lean
// checker consumes raw trees; it never sees an HTML string.
import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { preprocessHtml } from "../../src/adapters/parse5.js";
import { PREPROCESS_LIMITS } from "../../src/policy-protocol.js";

function give(world, html) {
  world.html = html;
  world.raw = null;
  world.pre = null;
}

Given("the generated HTML is {int} nested {string} elements", function (depth, tag) {
  give(this, `<${tag}>`.repeat(depth) + "deep" + `</${tag}>`.repeat(depth));
});

Given("the generated HTML is {int} copies of {string}", function (count, fragment) {
  give(this, fragment.repeat(count));
});

// Wide and shallow: many nodes, few open at once. This is the shape that
// reaches the node count bound without touching the open-node path bound.
Given("the generated HTML is {int} groups of {int} copies of {string}", function (groups, count, fragment) {
  give(this, `<div>${fragment.repeat(count)}</div>`.repeat(groups));
});

Given("the generated HTML is an element with {int} attributes", function (count) {
  give(this, `<p ${Array.from({ length: count }, (_, i) => `a${i}="1"`).join(" ")}>t</p>`);
});

Given("the generated HTML is an element whose tag name is {int} characters", function (length) {
  give(this, `<${"a".repeat(length)}>t</${"a".repeat(length)}>`);
});

Given("the generated HTML is a text node of {int} characters", function (length) {
  give(this, `<p>${"x".repeat(length)}</p>`);
});

Given("the generated HTML is {int} characters of markup", function (length) {
  const unit = "<p>x</p>";
  give(this, unit.repeat(Math.ceil(length / unit.length)).slice(0, length));
});

Given("the generated HTML is preprocessed:", function (html) {
  give(this, html);
});

When("the frontend preprocesses it", function () {
  assert.ok(typeof this.html === "string", "no HTML given; add a Given step");
  this.pre = preprocessHtml(this.html);
});

Then("preprocessing is rejected with {string}", function (code) {
  assert.ok(this.pre, "no preprocessing result; add a When step");
  assert.equal(this.pre.status, "rejected", `preprocessing accepted ${this.html.length} characters`);
  assert.equal(this.pre.reason.code, code, JSON.stringify(this.pre.reason));
  // A structured value, never a thrown string.
  assert.equal(typeof this.pre.reason, "object");
});

Then("the exceeded limit is {string}", function (limit) {
  assert.equal(this.pre.reason.limit, limit, JSON.stringify(this.pre.reason));
  assert.equal(this.pre.reason.limitValue, PREPROCESS_LIMITS[limit]);
  assert.ok(this.pre.reason.observed > this.pre.reason.limitValue, JSON.stringify(this.pre.reason));
});

Then("nothing reached the policy", function () {
  assert.equal(this.pre.raw, undefined);
  assert.equal(this.raw, null);
});

Then("preprocessing accepts it", function () {
  assert.ok(this.pre, "no preprocessing result; add a When step");
  assert.equal(this.pre.status, "ok", JSON.stringify(this.pre.reason ?? {}));
});

Then("the raw tree has {int} levels", function (depth) {
  assert.equal(this.pre.stats.rawDepth, depth);
});

When("the policy validates the preprocessed tree", async function () {
  assert.equal(this.pre.status, "ok", "preprocessing rejected the document");
  this.raw = this.pre.raw;
  await this.validate(["js"]);
});
