"use client";

import { CheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { saveNotifications, sendSlackTest, slackTestStatus } from "@/app/actions/notifications";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import type { NotificationSettingsRow } from "@/db/schema";
import type { SlackReadiness } from "@/lib/machine";
import { parseNotificationConfig, SLACK_TARGETS, TARGET_LABELS, type NotificationConfig, type SlackTarget } from "@/lib/notifications";
import { NOTIFY_TOGGLES, TOGGLE_LABELS, type NotifyToggle } from "@/lib/slack";
import { useAfterHydration } from "./time";

const POLL_MS = 1_500;
const GIVE_UP_MS = 60_000;

const Cmd = ({ children }: { children: string }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>;

function Status({ slack, target }: { slack: SlackReadiness | null; target: SlackTarget }) {
  const [icon, label, howTo]: [ReactNode, ReactNode, ReactNode] = !slack
    ? [<TriangleAlertIcon key="i" className="mt-0.5 size-4 shrink-0 text-warning" />, "No online runner reports Slack yet", "Runners report it with their inventory, at startup and every few minutes."]
    : !slack.configured
      ? [
          <XIcon key="i" className="mt-0.5 size-4 shrink-0 text-destructive" />,
          "Slack not connected",
          <>
            Add <Cmd>SLACK_BOT_TOKEN</Cmd>, <Cmd>SLACK_SIGNING_SECRET</Cmd> and <Cmd>SLACK_OWNER_USER_ID</Cmd> to the runner checkout&apos;s{" "}
            <Cmd>.env.local</Cmd> and restart the runner.
          </>,
        ]
      : !slack.owner && target === "owner"
        ? [
            <TriangleAlertIcon key="i" className="mt-0.5 size-4 shrink-0 text-warning" />,
            "Slack connected, but no runner knows who you are in Slack",
            <>
              Add your member id as <Cmd>SLACK_OWNER_USER_ID</Cmd> to the runner&apos;s <Cmd>.env.local</Cmd>, or send to a channel.
            </>,
          ]
        : [<CheckIcon key="i" className="mt-0.5 size-4 shrink-0 text-success" />, "Slack connected", null];
  return (
    <div className="flex gap-2.5 rounded-lg border p-3 text-sm">
      {icon}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span>{label}</span>
        {howTo && <span className="text-muted-foreground">{howTo}</span>}
      </div>
    </div>
  );
}

export function NotificationsCard({ saved, slack }: { saved: NotificationSettingsRow | null; slack: SlackReadiness | null }) {
  const router = useRouter();
  const current = parseNotificationConfig(saved?.config);
  const browserZone = useAfterHydration(() => Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");

  const [target, setTarget] = useState<SlackTarget>(current.target);
  const [channelId, setChannelId] = useState(current.channelId ?? "");
  const [events, setEvents] = useState(current.events);
  const [quietOn, setQuietOn] = useState(current.quietHours !== null);
  const [start, setStart] = useState(current.quietHours?.start ?? "22:00");
  const [end, setEnd] = useState(current.quietHours?.end ?? "07:00");
  const [zone, setZone] = useState<string | null>(current.quietHours?.timeZone ?? null);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const [testing, setTesting] = useState(false);

  const config: NotificationConfig = {
    target,
    channelId: target === "channel" ? channelId.trim() : current.channelId,
    events,
    quietHours: quietOn ? { start: start.slice(0, 5), end: end.slice(0, 5), timeZone: (zone ?? browserZone).trim() } : null,
  };
  const unchanged = saved !== null && JSON.stringify(config) === JSON.stringify(current);
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setSavedNow(null);
  };

  const submit = () => {
    setFailure(null);
    startSaving(async () => {
      const outcome = await saveNotifications(config);
      if (!outcome.ok) return setFailure(outcome.message);
      setSavedNow(outcome.message ?? "Saved. The runner uses it on its next tick.");
      router.refresh();
    });
  };

  const test = async () => {
    setFailure(null);
    setTesting(true);
    try {
      const sent = await sendSlackTest(crypto.randomUUID());
      if (!sent.ok) return setFailure(sent.message);
      const started = Date.now();
      while (Date.now() - started < GIVE_UP_MS) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const outcome = await slackTestStatus(sent.intentId);
        if (outcome.status === "pending") continue;
        if (outcome.status === "done") toastManager.add({ type: "success", title: outcome.message });
        else setFailure(outcome.message);
        return;
      }
      setFailure("No runner has sent it yet. Check that one is online on the Machines page.");
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          The runner posts a Slack message when a job needs you, when the factory merges or reverts on its own, and edits the same message once
          it is resolved.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Status slack={slack} target={target} />
        <Field>
          <FieldLabel htmlFor="notify-target">Send to</FieldLabel>
          <Select items={SLACK_TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] }))} value={target} onValueChange={(value) => value && edit(setTarget)(value)}>
            <SelectTrigger id="notify-target" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {SLACK_TARGETS.map((t) => (
                <SelectItem key={t} value={t}>
                  {TARGET_LABELS[t]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <FieldDescription>Off posts nothing new; messages already sent are still marked resolved.</FieldDescription>
        </Field>
        {target === "channel" && (
          <Field>
            <FieldLabel htmlFor="notify-channel">Channel id</FieldLabel>
            <Input id="notify-channel" value={channelId} placeholder="C0123456789" onChange={(e) => edit(setChannelId)(e.target.value)} className="font-mono" />
            <FieldDescription>In Slack, open the channel&apos;s details; the id is at the bottom. Invite the app first if the channel is private.</FieldDescription>
          </Field>
        )}
        <div className="flex flex-col gap-3">
          <span className="text-sm font-medium">Send a message for</span>
          {NOTIFY_TOGGLES.map((toggle: NotifyToggle) => (
            <label key={toggle} className="flex items-center justify-between gap-3 text-sm">
              <span>{TOGGLE_LABELS[toggle]}</span>
              <Switch checked={events[toggle]} onCheckedChange={(on) => edit(setEvents)({ ...events, [toggle]: on })} />
            </label>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">Quiet hours</span>
            <Switch checked={quietOn} onCheckedChange={edit(setQuietOn)} />
          </label>
          {quietOn && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="notify-quiet-start">From</FieldLabel>
                <Input id="notify-quiet-start" type="time" value={start} onChange={(e) => edit(setStart)(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="notify-quiet-end">Until</FieldLabel>
                <Input id="notify-quiet-end" type="time" value={end} onChange={(e) => edit(setEnd)(e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="notify-quiet-zone">Time zone</FieldLabel>
                <Input id="notify-quiet-zone" value={zone ?? browserZone} onChange={(e) => edit(setZone)(e.target.value)} />
              </Field>
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            During quiet hours only failed reverts and stops that couldn&apos;t be confirmed are sent. Anything else that still needs you when they
            end is sent then; what was resolved in the meantime is not sent at all.
          </p>
        </div>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </CardContent>
      <CardFooter className="gap-3">
        <Button onClick={submit} disabled={saving || unchanged}>
          {saving && <Spinner data-icon="inline-start" />}
          Save
        </Button>
        <Button variant="outline" onClick={() => void test()} disabled={testing || !slack?.configured}>
          {testing && <Spinner data-icon="inline-start" />}
          Send test message
        </Button>
        {savedNow && unchanged && <span className="text-sm text-muted-foreground">{savedNow}</span>}
      </CardFooter>
    </Card>
  );
}
