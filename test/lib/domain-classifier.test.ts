import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain } from "../../lib/domain-classifier.js";

describe("classifyDomain", () => {
  it("classifies eDiscovery text", () => {
    const { domain, confidence } = classifyDomain(
      "The custodian must place a legal hold on all ESI for this litigation matter.",
    );
    assert.equal(domain, "eDiscovery");
    assert.ok(confidence > 0);
  });

  it("classifies Legal text", () => {
    const { domain } = classifyDomain(
      "The contract clause establishes jurisdiction and limits liability for breach.",
    );
    assert.equal(domain, "Legal");
  });

  it("classifies Tech text", () => {
    const { domain } = classifyDomain(
      "Configure the API endpoint settings and deploy the server with authentication.",
    );
    assert.equal(domain, "Tech");
  });

  it("returns general for plain text with no keywords", () => {
    const { domain, confidence } = classifyDomain("Click to save your changes.");
    assert.equal(domain, "general");
    assert.equal(confidence, 0);
  });

  it("returns hits object with counts", () => {
    const { hits } = classifyDomain("The custodian and the legal hold review.");
    assert.ok(typeof hits === "object");
    assert.ok("eDiscovery" in hits);
    assert.ok("Legal" in hits);
    assert.ok("Tech" in hits);
  });

  it("confidence is in [0, 1]", () => {
    const { confidence } = classifyDomain("API endpoint for legal compliance");
    assert.ok(confidence >= 0 && confidence <= 1);
  });

  it("handles empty string", () => {
    const { domain, confidence } = classifyDomain("");
    assert.equal(domain, "general");
    assert.equal(confidence, 0);
  });

  it("is case-insensitive for keyword matching", () => {
    const lower = classifyDomain("legal hold custodian").hits;
    const upper = classifyDomain("LEGAL HOLD CUSTODIAN").hits;
    assert.deepEqual(lower, upper);
  });

  it("eDiscovery keywords take precedence over Legal when more hits", () => {
    // Many eDiscovery terms: custodian, legal hold, ESI, spoliation, Bates, privilege
    const { domain } = classifyDomain(
      "custodian legal hold ESI spoliation Bates privilege redact",
    );
    assert.equal(domain, "eDiscovery");
  });
});
