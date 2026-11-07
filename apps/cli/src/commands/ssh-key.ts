import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { client, conn, keyId } from "../api.ts";
import { guard } from "../common.ts";

interface Key { id: string; name: string; keyType: string; fingerprint: string; appCount: number; lastUsedAt: string | null }

const importKey = defineCommand({
  meta: { name: "import", description: "Import a private SSH key (used to clone private repositories). Stored encrypted." },
  args: {
    name: { type: "positional", required: true, description: "a label, e.g. work-github" },
    file: { type: "string", required: true, description: "path to the private key file (use - for stdin)" },
    passphrase: { type: "string", description: "passphrase, if the key is encrypted (or $FREIGHTER_KEY_PASSPHRASE)" },
    ...conn,
  },
  run: ({ args }) =>
    guard(async () => {
      const privateKey = args.file === "-" ? readFileSync(0, "utf8") : readFileSync(args.file, "utf8");
      const passphrase = args.passphrase ?? process.env.FREIGHTER_KEY_PASSPHRASE;
      const k = await client(args)<Key & { publicKey: string }>("/ssh-keys", "POST", { name: args.name, privateKey, ...(passphrase ? { passphrase } : {}) });
      console.log(`imported "${k.name}"  ${k.keyType}  ${k.fingerprint}\n\npublic key:\n${k.publicKey}`);
    }),
});

const generate = defineCommand({
  meta: { name: "generate", description: "Create a new ed25519 key on the server and print its public half to add to your git host" },
  args: { name: { type: "positional", required: true, description: "a label, e.g. deploy-acme" }, ...conn },
  run: ({ args }) =>
    guard(async () => {
      const k = await client(args)<Key & { publicKey: string }>("/ssh-keys/generate", "POST", { name: args.name });
      console.log(`created "${k.name}"  ${k.keyType}  ${k.fingerprint}\n\nAdd this public key to your git host (read access is enough):\n${k.publicKey}`);
    }),
});

const list = defineCommand({
  meta: { name: "list", description: "List imported SSH keys" },
  args: { ...conn },
  run: ({ args }) =>
    guard(async () => {
      const { keys } = await client(args)<{ keys: Key[] }>("/ssh-keys");
      if (keys.length === 0) return void console.log("no SSH keys imported");
      for (const k of keys) console.log(`${k.name.padEnd(24)} ${k.keyType.padEnd(8)} ${k.fingerprint}  ${k.appCount} app${k.appCount === 1 ? "" : "s"}  last used ${k.lastUsedAt ?? "never"}`);
    }),
});

const remove = defineCommand({
  meta: { name: "remove", description: "Delete an imported SSH key (refused while apps use it)" },
  args: { name: { type: "positional", required: true }, ...conn },
  run: ({ args }) =>
    guard(async () => {
      const call = client(args);
      await call(`/ssh-keys/${await keyId(call, args.name)}`, "DELETE");
      console.log(`removed ${args.name}`);
    }),
});

export const sshKey = defineCommand({
  meta: { name: "ssh-key", description: "Manage imported SSH keys (talks to the API: --url/--token or $FREIGHTER_URL/$FREIGHTER_TOKEN)" },
  subCommands: { import: importKey, generate, list, remove },
});
