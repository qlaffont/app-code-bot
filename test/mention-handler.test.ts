import { beforeEach, describe, expect, test } from "bun:test";

import { createDatabase } from "../src/db/database";
import { createMentionHandler, type Mention } from "../src/mention-handler";
import { createThreadStore } from "../src/thread-store";
import { FakeMediaReader, FakeSlack, FakeT3, internalMember, slackFile } from "./fakes";

const SYSTEM_PROMPT = "Tu es AppCode.";
const CAPTURE_OFFER =
    "_Si tu souhaites une vidéo ou des captures d'écran du parcours, indique-le-moi en me mentionnant dans ce fil._";
/** An answer as posted when it came without captures. */
const withOffer = (text: string) => `${text}\n\n${CAPTURE_OFFER}`;

const mention = (overrides: Partial<Mention> = {}): Mention => ({
    eventId: `Ev${Math.random()}`,
    channel: "CDEV",
    channelType: "channel",
    ts: "1000.1",
    userId: "UASKER",
    text: "<@UBOT> comment est calculée la facture ?",
    files: [],
    ...overrides,
});

let slack: FakeSlack;
let t3: FakeT3;
let media: FakeMediaReader;
let handle: (mention: Mention) => Promise<void>;

beforeEach(() => {
    slack = new FakeSlack();
    t3 = new FakeT3();
    media = new FakeMediaReader();
    handle = createMentionHandler({
        slack,
        t3,
        store: createThreadStore(createDatabase(":memory:")),
        media,
        systemPrompt: SYSTEM_PROMPT,
        botUserId: "UBOT",
        workspaceTeamId: "TAPP",
        answerTimeoutMs: 5 * 60_000,
        pollIntervalMs: 15_000,
        now: () => t3.elapsedMs,
    });
});

describe("a question in a channel", () => {
    test("launches a T3 thread with the dedicated prompt and the question", async () => {
        await handle(mention());

        expect(t3.launched).toHaveLength(1);
        expect(t3.launched[0]?.title).toBe("Slack · Alice · comment est calculée la facture ?");
        expect(t3.launched[0]?.message).toStartWith(SYSTEM_PROMPT);
        expect(t3.launched[0]?.message).toContain("comment est calculée la facture ?");
        expect(t3.launched[0]?.message).not.toContain("<@UBOT>");
    });

    test("keeps mentions of other people in the question", async () => {
        await handle(mention({ text: "<@UBOT> qu'a changé <@UALICE> dans la facturation ?" }));

        expect(t3.launched[0]?.message).toContain("qu'a changé <@UALICE> dans la facturation ?");
    });

    test("replaces the loading message with the answer, mentioning the asker, in the message's thread", async () => {
        t3.script.push({ outcome: "completed", answer: "C'est dans **billing**." });

        await handle(mention());

        expect(slack.posted[0]?.text).toBe("🔎 Je fouille le code…");
        expect(slack.visibleTexts()).toEqual([withOffer("<@UASKER> C'est dans *billing*.")]);
        expect(slack.posted.every((message) => message.channel === "CDEV" && message.threadTs === "1000.1")).toBe(true);
    });

    test("settles the T3 thread once answered", async () => {
        await handle(mention());

        expect(t3.settled).toEqual(["thread-1"]);
    });
});

describe("a follow-up mention in the same Slack thread", () => {
    test("is sent to the T3 thread that answered the first question", async () => {
        await handle(mention());
        t3.script.push({ outcome: "completed", answer: "Oui, aussi pour les avoirs." });

        await handle(mention({ ts: "1000.5", threadTs: "1000.1", text: "<@UBOT> Et pour les Avoirs ?" }));

        expect(t3.launched).toHaveLength(1);
        expect(t3.sent).toHaveLength(1);
        expect(t3.sent[0]?.threadId).toBe("thread-1");
        expect(t3.sent[0]?.message).toContain("Et pour les Avoirs ?");
        expect(t3.sent[0]?.message).not.toContain(SYSTEM_PROMPT);
        expect(slack.visibleTexts().at(-1)).toBe(withOffer("<@UASKER> Oui, aussi pour les avoirs."));
    });

    test("starts a new T3 thread with the Slack history when the previous one is gone", async () => {
        await handle(mention());
        t3.goneThreads.add("thread-1");
        slack.history = [
            { userId: "UASKER", text: "<@UBOT> comment est calculée la facture ?", ts: "1000.1", files: [] },
            { userId: "UBOT", text: "<@UASKER> C'est dans billing.", ts: "1000.2", files: [] },
            { userId: "UASKER", text: "<@UBOT> et pour les avoirs ?", ts: "1000.5", files: [] },
        ];

        await handle(mention({ ts: "1000.5", threadTs: "1000.1", text: "<@UBOT> et pour les avoirs ?" }));

        expect(t3.launched).toHaveLength(2);
        expect(t3.launched[1]?.message).toStartWith(SYSTEM_PROMPT);
        expect(t3.launched[1]?.message).toContain("C'est dans billing.");
        expect(slack.visibleTexts().at(-1)).toBe(withOffer("<@UASKER> Réponse par défaut."));

        t3.script.push({ outcome: "completed", answer: "Troisième." });
        await handle(mention({ ts: "1000.9", threadTs: "1000.1", text: "<@UBOT> encore ?" }));
        expect(t3.sent.at(-1)?.threadId).toBe("thread-3");
    });
});

describe("two mentions arriving together in the same Slack thread", () => {
    test("are answered one after the other by the same T3 thread", async () => {
        t3.script.push({ outcome: "completed", answer: "Première." }, { outcome: "completed", answer: "Seconde." });

        await Promise.all([
            handle(mention()),
            handle(mention({ ts: "1000.2", threadTs: "1000.1", text: "<@UBOT> et les avoirs ?" })),
        ]);

        expect(t3.launched).toHaveLength(1);
        expect(t3.sent.map((sent) => sent.threadId)).toEqual(["thread-1"]);
        expect(slack.visibleTexts()).toEqual([withOffer("<@UASKER> Première."), withOffer("<@UASKER> Seconde.")]);
    });
});

describe("a first mention inside an existing Slack conversation", () => {
    test("gives the agent the thread's earlier messages as context, without the question itself", async () => {
        slack.history = [
            { userId: "UBOB", text: "La facture de mars est fausse", ts: "1000.1", files: [] },
            { userId: "UASKER", text: "<@UBOT> pourquoi ?", ts: "1000.3", files: [] },
            { userId: "UBOT", text: "🔎 Je fouille le code…", ts: "1000.4", files: [] },
        ];

        await handle(mention({ ts: "1000.3", threadTs: "1000.1", text: "<@UBOT> pourquoi ?" }));

        const message = t3.launched[0]?.message ?? "";
        expect(message).toContain("<@UBOB> : La facture de mars est fausse");
        expect(message.split("pourquoi ?")).toHaveLength(2);
        expect(message).not.toContain("Je fouille le code");
    });
});

describe("who can ask", () => {
    test("a guest gets a polite refusal and no T3 thread is created", async () => {
        slack.users.set("UGUEST", { ...internalMember("UGUEST", "Gus"), isRestricted: true });

        await handle(mention({ userId: "UGUEST" }));

        expect(t3.launched).toHaveLength(0);
        expect(slack.visibleTexts()).toEqual(["<@UGUEST> Désolé, je ne réponds qu'aux membres internes de l'équipe."]);
    });

    test("someone from another organization gets the same refusal", async () => {
        slack.users.set("UEXT", { ...internalMember("UEXT", "Eve"), teamId: "TOTHER" });

        await handle(mention({ userId: "UEXT" }));

        expect(t3.launched).toHaveLength(0);
        expect(slack.visibleTexts()).toEqual(["<@UEXT> Désolé, je ne réponds qu'aux membres internes de l'équipe."]);
    });

    test("a user Slack can't describe (e.g. external) is treated as external", async () => {
        await handle(mention({ userId: "UUNKNOWN" }));

        expect(t3.launched).toHaveLength(0);
        expect(slack.visibleTexts()).toEqual([
            "<@UUNKNOWN> Désolé, je ne réponds qu'aux membres internes de l'équipe.",
        ]);
    });

    test("a Slack outage while checking the asker is reported as an error, not as a refusal", async () => {
        slack.failGetUser = true;

        await handle(mention());

        expect(t3.launched).toHaveLength(0);
        expect(slack.visibleTexts()).toEqual(["<@UASKER> ❌ Une erreur est survenue, réessaie dans un moment."]);
    });

    test("a direct message is redirected to channels", async () => {
        await handle(mention({ channelType: "im" }));

        expect(t3.launched).toHaveLength(0);
        expect(slack.visibleTexts()).toEqual([
            "<@UASKER> Je ne réponds que dans les canaux : mentionne-moi dans un canal 🙂",
        ]);
    });

    test("bots are ignored silently", async () => {
        slack.users.set("UROBOT", { ...internalMember("UROBOT", "Robot"), isBot: true });

        await handle(mention({ userId: "UROBOT" }));

        expect(t3.launched).toHaveLength(0);
        expect(slack.posted).toHaveLength(0);
    });
});

describe("a mention without a question", () => {
    test("asks for the question instead of launching T3", async () => {
        await handle(mention({ text: "<@UBOT>" }));

        expect(t3.launched).toHaveLength(0);
        expect(slack.visibleTexts()).toEqual(["<@UASKER> Pose-moi ta question juste après la mention 🙂"]);
    });
});

describe("when T3 doesn't answer cleanly", () => {
    test("after 5 minutes the run is stopped and the asker is told to rephrase", async () => {
        t3.script.push({ running: true });

        await handle(mention());

        expect(t3.elapsedMs).toBe(5 * 60_000);
        expect(t3.interrupted).toEqual(["run-2"]);
        expect(slack.visibleTexts()).toEqual([
            "<@UASKER> ❌ Je n'ai pas réussi à répondre à temps, reformule ou précise ta question.",
        ]);
    });

    test("after a timeout the agent is asked to tear down what it started, and the thread stays open", async () => {
        t3.script.push({ running: true });

        await handle(mention());

        expect(t3.sent.at(-1)?.threadId).toBe("thread-1");
        expect(t3.sent.at(-1)?.message).toContain("nettoie");
        expect(t3.settled).toEqual([]);
    });

    test("the timeout is still reported when interrupting the run fails", async () => {
        t3.script.push({ running: true });
        t3.failInterrupt = true;

        await handle(mention());

        expect(slack.visibleTexts()).toEqual([
            "<@UASKER> ❌ Je n'ai pas réussi à répondre à temps, reformule ou précise ta question.",
        ]);
    });

    test("an agent waiting for an answer is interrupted and told to carry on alone, once", async () => {
        t3.script.push({ pending: true }, { outcome: "completed", answer: "Lu sans rien exécuter." });

        await handle(mention());

        expect(t3.interrupted).toEqual(["run-2"]);
        expect(t3.sent).toHaveLength(1);
        expect(t3.sent[0]?.message).toContain("personne ne peut te répondre");
        expect(slack.visibleTexts()).toEqual([withOffer("<@UASKER> Lu sans rien exécuter.")]);
    });

    test("an agent blocked twice gives up with an explanation", async () => {
        t3.script.push({ pending: true }, { pending: true });

        await handle(mention());

        expect(t3.interrupted).toEqual(["run-2", "run-3"]);
        expect(t3.sent.at(-1)?.message).toContain("nettoie");
        expect(slack.visibleTexts()).toEqual([
            "<@UASKER> ❌ Je suis resté bloqué en attendant une réponse. Reformule ou précise ta question.",
        ]);
    });

    test("a failed run is reported as an error", async () => {
        t3.script.push({ outcome: "failed" });

        await handle(mention());

        expect(t3.settled).toEqual(["thread-1"]);
        expect(slack.visibleTexts()).toEqual(["<@UASKER> ❌ Une erreur est survenue, réessaie dans un moment."]);
    });

    test("an unreachable T3 is reported as an error and the loading message is removed", async () => {
        t3.failLaunch = true;

        await handle(mention());

        expect(slack.visibleTexts()).toEqual(["<@UASKER> ❌ Une erreur est survenue, réessaie dans un moment."]);
    });

    test("an answer made only of code is not shared", async () => {
        t3.script.push({ outcome: "completed", answer: "```ts\nconst secret = 1;\n```" });

        await handle(mention());

        expect(slack.visibleTexts()).toEqual([
            "<@UASKER> Ma réponse ne contenait que du code, que je ne peux pas partager. Reformule ta question.",
        ]);
    });
});

describe("Slack delivering the same event twice", () => {
    test("is answered once", async () => {
        const event = mention({ eventId: "Ev1" });

        await Promise.all([handle(event), handle(event)]);

        expect(t3.launched).toHaveLength(1);
        expect(slack.visibleTexts()).toHaveLength(1);
    });
});

describe("images posted with the question", () => {
    test("are uploaded to T3 and attached to the new thread", async () => {
        await handle(mention({ files: [slackFile("ecran.png", "image/png"), slackFile("detail.jpg", "image/jpeg")] }));

        expect(t3.launched[0]?.attachments.map((attachment) => attachment.name)).toEqual(["ecran.png", "detail.jpg"]);
    });

    test("are attached to a follow-up in an existing T3 thread", async () => {
        await handle(mention());

        await handle(
            mention({
                ts: "1000.5",
                threadTs: "1000.1",
                text: "<@UBOT> et ça ?",
                files: [slackFile("bug.webp", "image/webp")],
            }),
        );

        expect(t3.sent[0]?.attachments?.map((attachment) => attachment.name)).toEqual(["bug.webp"]);
    });

    test("videos, other files and oversized images are skipped and the asker is told", async () => {
        t3.script.push({ outcome: "completed", answer: "Voilà." });

        await handle(
            mention({
                files: [
                    slackFile("ecran.png", "image/png"),
                    slackFile("demo.mp4", "video/mp4"),
                    slackFile("notes.pdf", "application/pdf"),
                    slackFile("enorme.png", "image/png", 11 * 1024 * 1024),
                ],
            }),
        );

        expect(t3.uploadedImages).toEqual(["ecran.png"]);
        expect(slack.visibleTexts()).toEqual([
            withOffer(
                "<@UASKER> Voilà.\n\n_Je n'ai pas pu regarder : demo.mp4, notes.pdf, enorme.png (je ne lis que les images de moins de 10 Mo, 8 au maximum)._",
            ),
        ]);
    });

    test("are uploaded once even when the previous T3 thread is gone", async () => {
        await handle(mention());
        t3.goneThreads.add("thread-1");

        await handle(
            mention({
                ts: "1000.5",
                threadTs: "1000.1",
                text: "<@UBOT> et ça ?",
                files: [slackFile("bug.png", "image/png")],
            }),
        );

        expect(t3.uploadedImages).toEqual(["bug.png"]);
        expect(t3.launched[1]?.attachments.map((attachment) => attachment.name)).toEqual(["bug.png"]);
    });

    test("images that can't be sent to T3, or beyond 8, are reported too", async () => {
        t3.failingUploads.add("casse.png");
        t3.script.push({ outcome: "completed", answer: "Voilà." });
        const images = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => slackFile(`img-${n}.png`, "image/png"));

        await handle(mention({ files: [slackFile("casse.png", "image/png"), ...images] }));

        expect(t3.uploadedImages).toEqual(images.slice(0, 7).map((image) => image.name));
        expect(slack.visibleTexts()[0]).toContain("Je n'ai pas pu regarder : img-8.png, img-9.png, casse.png");
    });

    test("a new thread also gets the latest images posted earlier in the Slack thread, up to 5", async () => {
        slack.history = [1, 2, 3, 4, 5, 6].map((n) => ({
            userId: "UBOB",
            text: `capture ${n}`,
            ts: `1000.${n}`,
            files: [slackFile(`old-${n}.png`, "image/png")],
        }));

        await handle(
            mention({
                ts: "1000.9",
                threadTs: "1000.1",
                text: "<@UBOT> pourquoi ?",
                files: [slackFile("new.png", "image/png")],
            }),
        );

        expect(t3.launched[0]?.attachments.map((attachment) => attachment.name)).toEqual([
            "new.png",
            "old-2.png",
            "old-3.png",
            "old-4.png",
            "old-5.png",
            "old-6.png",
        ]);
    });
});

describe("captures produced by the agent", () => {
    test("an answer without captures offers them, after any long answer's last part", async () => {
        const paragraph = "a".repeat(2000);
        t3.script.push({ outcome: "completed", answer: [paragraph, paragraph].join("\n\n") });

        await handle(mention());

        expect(slack.visibleTexts()).toEqual([`<@UASKER> ${paragraph}`, withOffer(paragraph)]);
    });

    test("errors and refusals don't offer captures", async () => {
        t3.script.push({ outcome: "failed" });

        await handle(mention());

        expect(slack.visibleTexts()[0]).not.toContain("captures d'écran");
    });

    test("are published in the Slack thread and their markers removed from the text", async () => {
        media.files.set("/t3/browser-artifacts/facture.png", "png");
        media.files.set("/t3/attachments/parcours.webm", "webm");
        t3.script.push({
            outcome: "completed",
            answer: "Voici l'écran de facturation.\n\n[[media: /t3/browser-artifacts/facture.png]]\n[[media: /t3/attachments/parcours.webm]]",
        });

        await handle(mention());

        expect(slack.visibleTexts()).toEqual(["<@UASKER> Voici l'écran de facturation."]);
        expect(slack.uploaded).toEqual([
            {
                channel: "CDEV",
                threadTs: "1000.1",
                filenames: ["facture.png", "parcours.webm"],
            },
        ]);
    });

    test("files outside the T3 capture folders are never published", async () => {
        media.files.set("/t3/browser-artifacts/ok.png", "png");
        t3.script.push({
            outcome: "completed",
            answer: "Réponse.\n[[media: /home/t3/.ssh/id_ed25519]]\n[[media: /t3/browser-artifacts/ok.png]]",
        });

        await handle(mention());

        expect(slack.visibleTexts()).toEqual(["<@UASKER> Réponse."]);
        expect(slack.uploaded[0]?.filenames).toEqual(["ok.png"]);
    });

    test("at most 3 images and 1 video are published", async () => {
        const paths = ["1.png", "a.webm", "b.mp4", "2.png", "3.png", "4.png"].map(
            (name) => `/t3/browser-artifacts/${name}`,
        );
        for (const path of paths) media.files.set(path, "bytes");
        t3.script.push({
            outcome: "completed",
            answer: ["Écrans :", ...paths.map((path) => `[[media: ${path}]]`)].join("\n"),
        });

        await handle(mention());

        expect(slack.uploaded[0]?.filenames).toEqual(["1.png", "a.webm", "2.png", "3.png"]);
    });
});
