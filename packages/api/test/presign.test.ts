import { describe, expect, it } from "vitest";
import { presignGet } from "../src/presign.ts";

describe("presignGet", () => {
  it("makes the signature AWS documents for its example request", () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignGet({
      endpoint: "https://examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      expires: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("encodes a key the way the server will read it, and signs the host it was made for", () => {
    const a = presignGet({ endpoint: "https://s3.example.com", path: "/media/my photos/a+b (1).jpg", accessKey: "AK", secretKey: "sk", expires: 60, now: new Date("2026-11-12T10:00:00Z") });
    expect(a).toContain("/media/my%20photos/a%2Bb%20%281%29.jpg?");
    const b = presignGet({ endpoint: "https://other.example.com", path: "/media/my photos/a+b (1).jpg", accessKey: "AK", secretKey: "sk", expires: 60, now: new Date("2026-11-12T10:00:00Z") });
    expect(a.split("X-Amz-Signature=")[1]).not.toBe(b.split("X-Amz-Signature=")[1]);
  });
});
