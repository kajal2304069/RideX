import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import axios from "axios";
import MockAdapter from "axios-mock-adapter";
import { api, tokenStore } from "@/lib/api";
import { useAuth } from "@/store/auth";
import { AuthPage } from "@/pages/AuthPage";

const user = { id: "u1", email: "a@b.c", fullName: "Ann", phone: null, roles: ["RIDER", "ADMIN"] };

describe("auth store", () => {
  let mock: MockAdapter;
  beforeEach(() => { mock = new MockAdapter(api); tokenStore.set(null); useAuth.setState({ user: null, status: "loading" }); });

  it("login stores the token and user", async () => {
    mock.onPost("/auth/login").reply(200, { success: true, data: { user, accessToken: "t1" } });
    await useAuth.getState().login("a@b.c", "x");
    expect(tokenStore.get()).toBe("t1");
    expect(useAuth.getState().status).toBe("authenticated");
  });
  it("bootstrap without a refresh cookie ends anonymous", async () => {
    new MockAdapter(axios).onPost("/api/auth/refresh").reply(401, { success: false, error: { code: "UNAUTHORIZED", message: "no" } });
    await useAuth.getState().bootstrap();
    expect(useAuth.getState().status).toBe("anonymous");
  });
  it("has() checks roles", () => {
    useAuth.setState({ user: user as never, status: "authenticated" });
    expect(useAuth.getState().has("ADMIN")).toBe(true);
    expect(useAuth.getState().has("DRIVER")).toBe(false);
  });
  it("logout clears the session even if the server call fails", async () => {
    useAuth.setState({ user: user as never, status: "authenticated" }); tokenStore.set("t");
    mock.onPost("/auth/logout").networkError();
    await useAuth.getState().logout();
    expect(useAuth.getState().user).toBeNull();
    expect(tokenStore.get()).toBeNull();
  });
});

describe("AuthPage", () => {
  beforeEach(() => { useAuth.setState({ user: null, status: "anonymous" }); });
  it("shows the server's error when sign-in fails", async () => {
    const mock = new MockAdapter(api);
    mock.onPost("/auth/login").reply(401, { success: false, error: { code: "INVALID_CREDENTIALS", message: "Wrong email or password" } });
    render(<MemoryRouter><AuthPage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText(/email/i), "a@b.c");
    await userEvent.type(screen.getByLabelText(/password/i), "nope");
    await userEvent.click(screen.getByRole("button", { name: /sign in|log in/i }));
    await waitFor(() => expect(screen.getByText(/wrong email or password/i)).toBeInTheDocument());
  });
  void vi;
});
