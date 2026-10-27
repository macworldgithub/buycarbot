# Chat tracking: marketing team handover

The widget now pushes events to the website's `window.dataLayer` for Google Tag Manager (GTM). Marketing can send them to Google Analytics 4 (GA4) and use the captured-lead event for Google Ads conversions.

Deploy both `public/iife.js` and `index.js`, restart the backend, and refresh any widget/CDN cache first. Tracking starts after deployment and GTM publication; past clicks cannot be recovered. No GTM container or GA4 property has been configured by this code change.

## What each count means

| Event name | When it fires | How to use it |
| --- | --- | --- |
| `bmnc_chat_open` | Each click/tap on the floating icon that opens the chat. Keyboard activation counts too. | Total chat openings, including repeat openings. |
| `bmnc_chat_open_unique` | First icon opening in that browser tab's session, retained across same-origin page navigation and reloads. | Deduplicated tab sessions with an icon opening. This is not a count of unique people or GA4 sessions. |
| `bmnc_chat_started` | First successful chat-message response in a conversation. This includes the greeting sent when someone selects a language. | Conversations started. |
| `bmnc_lead_captured` | A successful message response confirms a phone/email has been captured, or a specialist/finance form succeeds. | Captured enquiries: use this as the lead conversion. |

Automatic opening, `BMNCWidget.open()` and `BMNCWidget.toggle()` do not fire icon-click events. Merely viewing a form, validation errors, and failed API requests do not create lead events. A captured enquiry is not a verified/qualified prospect or a sale, and does not guarantee an email was delivered.

Starts and leads are deduplicated per conversation in this browser using local storage, including across reloads and later form submissions. A new conversation can count again. These are browser measurements rather than CRM totals: clearing storage, using another browser/device, concurrent tabs, consent choices and blockers can affect counts. If storage is unavailable, deduplication lasts only for that page load. Unique opening markers use session storage; duplicated tabs may inherit their opener's marker.

## One-time GTM setup

1. Use the GTM **Web** container installed on the actual website where the floating icon appears. The widget uses the standard `dataLayer` name and runs in the host page. Ensure that container has the correct GA4 Google tag and web stream (`G-…`). Do not install another copy if one is already present.
2. In **Variables**, enable the built-in **Event** variable. Create three **Data Layer Variables**, version 2:

   | GTM variable name | Data Layer Variable Name |
   | --- | --- |
   | `DLV - BMNC Widget` | `widget_name` |
   | `DLV - BMNC Source` | `interaction_source` |
   | `DLV - BMNC Lead Method` | `lead_method` |

3. Create a **Custom Event** trigger named `BMNC - Chat events`. Enable regex matching and enter this exact, anchored expression:

   ```text
   ^bmnc_(chat_open|chat_open_unique|chat_started|lead_captured)$
   ```

4. Create a **Google Analytics: GA4 Event** tag named `GA4 - BMNC Chat`. Set the measurement ID to the existing GA4 web stream. Set **Event Name** to `{{Event}}`. Add these event parameters:

   | Parameter | Value |
   | --- | --- |
   | `widget_name` | `{{DLV - BMNC Widget}}` |
   | `interaction_source` | `{{DLV - BMNC Source}}` |
   | `lead_method` | `{{DLV - BMNC Lead Method}}` |

5. Attach `BMNC - Chat events` as the trigger. Use the site's existing consent setup for the Google tags. The widget itself only queues events and sets deduplication markers; it does not load GA4, ask for consent, or send events directly to Google or Meta. To disable this feature entirely, set `data-tracking-enabled="false"` on the widget script or `window.BMNC_CONFIG.trackingEnabled = false` before loading it.
6. Preview and validate using the checks below, then **Submit/Publish** the GTM container.

Use this event trigger instead of adding a second generic click tag to the icon: two tags sending the same event would inflate counts. Each event contains only the event name and the three parameters above. No name, phone, email, message text or conversation ID is included. GA4/Google tags may independently collect their usual page and campaign context.

Google documents the [data layer](https://developers.google.com/tag-platform/tag-manager/datalayer), [custom event triggers](https://support.google.com/tagmanager/answer/7679219?hl=en), and [GA4 event tags and verification](https://support.google.com/tagmanager/answer/13034206?hl=en).

## GA4 reporting and Google Ads

- In GA4, mark **`bmnc_lead_captured`** as a key event. Keep openings and starts as engagement metrics. If a campaign explicitly measures icon clicks, label that goal “Chat icon opening” and keep it separate from captured enquiries.
- Create event-scoped custom dimensions for `widget_name`, `interaction_source`, and `lead_method` if the team wants these breakdowns in reports. `lead_method` is `conversation`, `handover`, or `finance_referral` on the first counted lead event, and empty on other events. It describes how the lead was first captured, not whether it later received a finance referral.
- In the Events report or an Exploration, filter to these event names and review **Event count**. Break results down by **Session source / medium** and **Session campaign** to compare acquisition campaigns. Use the same date range and timezone for comparisons. For a progression view, build a funnel from opening → conversation started → lead captured; auto-open users may enter at conversation started.
- Use consistent campaign URLs, for example `https://YOUR-SITE/?utm_source=facebook&utm_medium=paid_social&utm_campaign=car_buyers`. Keep personal information out of campaign values. Use Google Ads auto-tagging for Google Ads traffic. The site's Google tag handles attribution; the widget does not copy UTM values or ad click IDs into its event payloads.
- For Google Ads, link the GA4 property and Ads account, then create/import a conversion from `bmnc_lead_captured`. Check whether it is Primary or Secondary before using it for bidding. Use one Primary action for this enquiry; avoid counting both a direct Google Ads tag and the GA4 import as Primary for the same lead. Keep click/open goals Secondary for observation when optimising for captured enquiries. See [Google's conversion setup instructions](https://support.google.com/google-ads/answer/10632359?hl=en).
- Review campaign spend against **attributed captured enquiries**, then check actual lead quality with the sales team. Do not report icon openings as qualified leads or sum all four events as a lead count.

## Pre-launch validation

Use GTM **Preview / Tag Assistant** and GA4 **DebugView**. Use test contact details and a test deployment when submitting enquiries, since the existing chat flow can send lead emails.

| Test | Expected events |
| --- | --- |
| Fresh tab session: click the icon | One `bmnc_chat_open` and one `bmnc_chat_open_unique`. |
| Close and reopen the chat | One more `bmnc_chat_open`; no more unique-opening events. |
| Reload/navigate in the same tab and open again | One more opening; no more unique-opening events. |
| Auto-open or run `BMNCWidget.open()` | No icon-click events. |
| Select a language and receive a successful reply | One `bmnc_chat_started`. |
| Successfully capture contact details in chat | One `bmnc_lead_captured` with `lead_method=conversation`. |
| In another new conversation, submit specialist details successfully | One lead with `lead_method=handover`. |
| In another new conversation, submit the consented finance form successfully | One lead with `lead_method=finance_referral`. |
| Continue/reload/resubmit within a counted conversation | No additional start or lead events. |
| Submit an invalid form or simulate a failed request | No new lead event. |

Confirm each data-layer event fires exactly one GA4 event tag and reaches the intended property. On a test page, inspect the queued payloads in the browser console:

```js
(window.dataLayer || []).filter(function (entry) {
  return entry && typeof entry.event === "string" && entry.event.indexOf("bmnc_") === 0;
});
```

If events appear here but not in GA4, check the container, regex trigger, measurement ID, consent state, blockers and publication status. No analytics account connection or live GA4 delivery was verified as part of the code change.

## Message you can forward to the team

> Chat tracking is ready for GTM/GA4 setup. Please follow the setup above and use `bmnc_chat_open` for total icon openings, `bmnc_chat_open_unique` for tab sessions with an opening, `bmnc_chat_started` for conversations, and `bmnc_lead_captured` for captured enquiries. Mark only the captured-enquiry event as our lead key event, connect it to Google Ads if needed, and report results by source/medium/campaign. Validate in Tag Assistant and DebugView before publishing. Keep icon clicks separate from actual enquiries and avoid duplicate conversion tags.
