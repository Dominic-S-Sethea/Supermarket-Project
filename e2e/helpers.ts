import { expect, type Page } from "@playwright/test";

export const E2E_ORIGIN = "http://127.0.0.1:5173";

export interface AllowedApiError {
  method?: string;
  pathIncludes: string;
  status: number;
}

export function attachErrorGuards(
  page: Page,
  options?: { allowApiErrors?: AllowedApiError[] }
) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  const allowed = options?.allowApiErrors ?? [];

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      if (allowed.length > 0 && text.includes("status of ")) {
        const hasAllowedStatus = allowed.some((rule) => text.includes(`status of ${rule.status}`));
        if (hasAllowedStatus) return;
      }
      consoleErrors.push(text);
    }
  });
  page.on("pageerror", (err) => {
    pageErrors.push(String(err));
  });
  page.on("response", (res) => {
    const url = res.url();
    const status = res.status();
    const method = res.request().method();
    if (url.includes("/api/") && status >= 400) {
      const isExpected = allowed.some(
        (rule) =>
          rule.status === status &&
          (!rule.method || rule.method === method) &&
          url.includes(rule.pathIncludes)
      );
      if (!isExpected) {
        serverErrors.push(`${status} ${method} ${url}`);
      }
    }
  });

  return {
    assertClean() {
      expect(pageErrors, `Uncaught page errors: ${pageErrors.join(" | ")}`).toEqual([]);
      expect(consoleErrors, `Console errors: ${consoleErrors.join(" | ")}`).toEqual([]);
      expect(serverErrors, `Unexpected API >=400 responses: ${serverErrors.join(" | ")}`).toEqual(
        []
      );
    },
  };
}

export async function loginAs(page: Page, username: string, pin: string) {
  await page.goto("/");
  await expect(page.locator("#login-username")).toBeVisible();
  await page.fill("#login-username", username);
  await page.fill("#login-pin", pin);
  await page.click("#login-submit-btn");
  await expect(page.locator("#logout-btn")).toBeVisible();
}

export async function loginAsOwner(page: Page) {
  await loginAs(page, "owner", "1111");
}

export async function logout(page: Page) {
  await page.click("#logout-btn");
  await expect(page.locator("#login-username")).toBeVisible();
}
