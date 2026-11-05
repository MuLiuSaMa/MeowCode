import { describe, expect, it } from "vitest";
import {
  ACL_HEADER_SIZE,
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  CONTAINER_INHERIT_ACE,
  EXPLICIT_ACCESS_W_SIZE,
  FILE_DELETE_CHILD,
  GRANT_MASK,
  INHERITED_ACE,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  MANDATORY_ACE_OVERHEAD,
  SUB_CONTAINERS_AND_OBJECTS_INHERIT,
  SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
  TOKEN_MANDATORY_LABEL_SIZE,
  TRUSTEE_W_OFFSET,
  TRUSTEE_W_PTSTRNAME_OFFSET,
  WinLowLabelSid,
  WinWorldSid,
} from "./abi.js";

describe("Win32 ABI constants", () => {
  it("keeps the capability mask free of WRITE_DAC/WRITE_OWNER", () => {
    expect(GRANT_MASK).toBe(0x110156);
  });

  it("matches the x64 EXPLICIT_ACCESS_W layout", () => {
    expect(EXPLICIT_ACCESS_W_SIZE).toBe(48);
    expect(TRUSTEE_W_OFFSET).toBe(16);
    expect(TRUSTEE_W_PTSTRNAME_OFFSET).toBe(24);
  });

  it("keeps the deny ACE container-only", () => {
    expect(CONTAINER_INHERIT_ACE).toBe(0x2);
    expect(SUB_CONTAINERS_AND_OBJECTS_INHERIT).toBe(0x3);
    expect(FILE_DELETE_CHILD).toBe(0x40);
  });

  it("keeps the Low integrity label and job flags", () => {
    expect(WinLowLabelSid).toBe(66);
    expect(WinWorldSid).toBe(1);
    expect(SYSTEM_MANDATORY_LABEL_NO_WRITE_UP).toBe(0x1);
    expect(TOKEN_MANDATORY_LABEL_SIZE).toBe(16);
    expect(ACL_HEADER_SIZE).toBe(8);
    expect(MANDATORY_ACE_OVERHEAD).toBe(8);
    expect(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000);
  });

  it("keeps the ACE type values", () => {
    expect(ACCESS_ALLOWED_ACE_TYPE).toBe(0);
    expect(ACCESS_DENIED_ACE_TYPE).toBe(1);
    expect(INHERITED_ACE).toBe(0x10);
  });
});
