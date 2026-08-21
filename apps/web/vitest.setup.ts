import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// globals 关闭时 RTL 的自动清理不会挂上，这里显式卸载，避免用例间 DOM 泄漏。
afterEach(() => {
  cleanup();
});
