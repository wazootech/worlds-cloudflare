import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCloudflareWorldsSdk } from "./create-cloudflare-sdk.ts";
import { createTestD1 } from "@/cloudflare/d1-test-substrate.ts";
import { validateWorldId } from "./validate-world-id.ts";
import { D1ConnectionDriver } from "./d1/d1-connection-driver.ts";
import { D1RdfjsStore } from "./rdfjs-store/mod.ts";
import { backfillInference } from "./inference/backfill-inference.ts";

Deno.test("validateWorldId accepts undefined and non-empty strings", () => {
  validateWorldId(undefined, "ctx");
  validateWorldId("world-a", "ctx");
});

Deno.test("validateWorldId rejects empty, whitespace, and non-string worldIds", () => {
  for (const bad of ["", "   ", "\t", 42 as unknown as string]) {
    const error = assertThrows(() => validateWorldId(bad, "ctx")) as Error;
    assertEquals(error.message.includes("non-empty string"), true);
  }
});

Deno.test("createCloudflareWorldsSdk rejects an empty worldId", async () => {
  const substrate = await createTestD1();
  try {
    await assertRejects(
      () =>
        createCloudflareWorldsSdk({
          database: substrate.database,
          worldId: "",
        }),
      Error,
      "non-empty string",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("D1RdfjsStore and backfillInference reject an empty worldId", async () => {
  const substrate = await createTestD1();
  try {
    const connection = new D1ConnectionDriver(substrate.database, {});
    assertThrows(() => new D1RdfjsStore({ connection, worldId: "" }));
    await assertRejects(
      () => backfillInference({ database: substrate.database, worldId: "  " }),
      Error,
      "non-empty string",
    );
  } finally {
    await substrate.dispose();
  }
});

Deno.test("an unscoped open of a world-scoped database fails closed", async () => {
  const substrate = await createTestD1();
  try {
    const scoped = await createCloudflareWorldsSdk({
      database: substrate.database,
      worldId: "world-a",
    });
    await scoped.import({
      source: {
        kind: "serialized",
        data: "<urn:a> <urn:b> <urn:c> .\n",
        contentType: "application/n-quads",
      },
    });

    await assertRejects(
      () => createCloudflareWorldsSdk({ database: substrate.database }),
      Error,
      "world-scoped schema present but no worldId was provided",
    );
  } finally {
    await substrate.dispose();
  }
});
