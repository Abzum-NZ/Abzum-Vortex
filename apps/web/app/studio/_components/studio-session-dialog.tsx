"use client";
import { useState } from "react";
import { Button } from "@vortex/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@vortex/ui/components/dialog";
import { Input } from "@vortex/ui/components/input";
import { Label } from "@vortex/ui/components/label";
import type { useStudioSession } from "./use-studio-session";

export function StudioSessionDialog({ session }: { session: ReturnType<typeof useStudioSession> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <Dialog open={session.needsSignIn}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Sign in to save your edit</DialogTitle>
          <DialogDescription>
            Your session has ended. Your unsaved edit is kept here. Sign in and Studio will save it
            automatically.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (session.signingIn) return;
            void session.signIn(email, password).finally(() => setPassword(""));
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="studio-sign-in-email">Email</Label>
            <Input
              id="studio-sign-in-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              disabled={session.signingIn}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="studio-sign-in-password">Password</Label>
            <Input
              id="studio-sign-in-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={session.signingIn}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {session.message && <p role="alert">{session.message}</p>}
          <Button type="submit" disabled={session.signingIn}>
            {session.signingIn ? "Signing in…" : "Sign in and save"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
