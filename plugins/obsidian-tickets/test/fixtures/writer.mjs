import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const repo = process.argv[process.argv.indexOf("--repo") + 1];
const file = NodePath.join(repo, "documents.json");
const hash = (doc) => NodeCrypto.createHash("sha256").update(JSON.stringify(doc)).digest("hex");
const key = (id) => ({ vaultId: "vault", boardId: "board", ticketId: id });
const output = (value) => process.stdout.write(JSON.stringify(value));
if (request.operation === "capabilities") {
  output({ protocolVersion: 1 });
} else {
  const data = JSON.parse(await NodeFSP.readFile(file, "utf8"));
  if (request.operation === "search") {
    output({
      items: Object.entries(data.docs).map(([id, doc]) => ({ key: key(id), title: doc.title })),
      nextCursor: null,
    });
  } else if (request.operation === "read") {
    const doc = data.docs[request.ticketId];
    output(
      doc ? { ...doc, sha256: hash(doc), path: file } : { status: "failed", error: "missing" },
    );
  } else if (request.operation === "apply") {
    data.calls++;
    if (request.steps.some((step) => hash(data.docs[step.ticketId]) !== step.expectedSha256)) {
      await NodeFSP.writeFile(file, JSON.stringify(data));
      output({ status: "failed" });
    } else {
      for (const step of request.steps) {
        const doc = data.docs[step.ticketId];
        doc.references = doc.references.filter(
          (ref) =>
            ref.environmentId !== step.reference.environmentId ||
            ref.threadId !== step.reference.threadId,
        );
        if (step.action === "add") doc.references.push(step.reference);
        if (data.interrupt) {
          data.interrupt = false;
          await NodeFSP.writeFile(file, JSON.stringify(data));
          output({ status: "recovery-required" });
          process.exit(0);
        }
      }
      await NodeFSP.writeFile(file, JSON.stringify(data));
      output({ status: "committed" });
    }
  }
}
