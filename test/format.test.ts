import { describe, expect, test } from "bun:test";

import { formatAnswer } from "../src/format";

describe("formatAnswer", () => {
    test("removes fenced code blocks entirely", () => {
        const answer = "La facture est calculée ici.\n\n```ts\nconst total = a + b;\n```\n\nEt c'est tout.";

        expect(formatAnswer(answer)).toEqual(["La facture est calculée ici.\n\nEt c'est tout."]);
    });

    test("removes tilde-fenced code blocks too", () => {
        expect(formatAnswer("Avant\n\n~~~\ncode()\n~~~\n\nAprès")).toEqual(["Avant\n\nAprès"]);
    });

    test("drops everything after an unterminated code fence", () => {
        expect(formatAnswer("Voici :\n```\nsecret()\nencore()")).toEqual(["Voici :"]);
    });

    test("converts Markdown emphasis, headings, links and lists to Slack mrkdwn", () => {
        const answer = [
            "## Calcul de la facture",
            "",
            "Le total est **toujours** arrondi, c'est ~~faux~~ vrai.",
            "- voir `billing/invoice.service.ts`",
            "* puis la [doc](https://example.com/doc)",
        ].join("\n");

        expect(formatAnswer(answer)).toEqual([
            [
                "*Calcul de la facture*",
                "",
                "Le total est *toujours* arrondi, c'est ~faux~ vrai.",
                "• voir `billing/invoice.service.ts`",
                "• puis la <https://example.com/doc|doc>",
            ].join("\n"),
        ]);
    });

    test("splits long answers on paragraph boundaries under the size limit", () => {
        const paragraph = "a".repeat(2000);
        const answer = [paragraph, paragraph, paragraph].join("\n\n");

        expect(formatAnswer(answer, { maxChunkLength: 4100 })).toEqual([`${paragraph}\n\n${paragraph}`, paragraph]);
    });

    test("hard-splits a single paragraph longer than the limit", () => {
        expect(formatAnswer("x".repeat(25), { maxChunkLength: 10 })).toEqual([
            "x".repeat(10),
            "x".repeat(10),
            "x".repeat(5),
        ]);
    });

    test("escapes characters Slack treats as control sequences", () => {
        expect(formatAnswer("Si a < b & b > c")).toEqual(["Si a &lt; b &amp; b &gt; c"]);
    });
});
