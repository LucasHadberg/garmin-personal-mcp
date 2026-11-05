# garmin-personal-mcp

Connect your own Garmin Connect data to Claude (or another MCP client) and ask it
about your sleep, training, heart rate, weight and more.

The connector runs as a Cloudflare Worker on the free plan. It uses Garmin's
[Personal API](https://developer.garmin.com/gc-developer-program/personal/personal-api/),
which gives you read-only access to your own data with a key you create yourself.
The whole server is one JavaScript file with no dependencies, so you can read it
before you deploy it.

You don't need a server or a computer that stays on. Setup takes about 15 minutes.

## What you need

- A Garmin Connect account with data in it
- A free [Cloudflare](https://dash.cloudflare.com/sign-up) account
- A Claude plan that lets you add custom connectors (Settings → Connectors)

## How it works

```
Claude ──MCP──▶ your Cloudflare Worker ──Personal API──▶ Garmin Connect
          (OAuth sign-in with                (your API key, stored as
           your passphrase)                    a Cloudflare secret)
```

Claude connects to your Worker's `/mcp` address. The first time, your Worker shows
a sign-in page where you type an owner passphrase that only you know. After that,
Claude calls the tools below, and the Worker fetches the data from Garmin with your
key.

## Setup

### 1. Create a Garmin API key

1. Sign in at [connect.garmin.com](https://connect.garmin.com), open
   **Settings → Personal API Key**, or go straight to
   [the key page](https://connect.garmin.com/app/settings/personalApiToken).
2. Choose **Create Key**, accept the terms and pick an expiry. 90 days is a sensible
   start. Garmin emails you a week before it runs out.
3. Copy the key now and store it in a password manager. Garmin shows it only once.

### 2. Create an owner passphrase

Make a long random passphrase, for example five or more random words from your
password manager's generator. You type it once, when you connect Claude. It stops
anyone else from connecting to your Worker, even if they find its address. Don't
reuse a password from somewhere else.

### 3. Deploy the Worker

Everything happens in the Cloudflare website. You don't need to install anything.

1. In the Cloudflare dashboard, open **Workers & Pages**, click **Create
   application** and choose **Start with Hello World!**. Name it `garmin-mcp` and
   click **Deploy**.
2. Click **Edit code**. Select everything in `worker.js` and delete it.
3. In this repo, open [`src/index.js`](src/index.js) and click the **Copy raw file**
   button (top right of the file view). Paste it into `worker.js` and click
   **Deploy**.
4. Open the [Workers KV](https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces)
   page, click **Create instance**, name it `OAUTH_KV` and click **Create**.
5. Go back to your `garmin-mcp` Worker. Under **Settings → Bindings**, choose
   **Add binding → KV namespace**. Set the variable name to `OAUTH_KV`, pick the
   `OAUTH_KV` namespace and click **Add Binding**.
6. Under **Settings → Variables and Secrets**, click **Add** and enter these
   three, then click **Add variables and deploy**:

   | Key | Value | Type |
   | --- | --- | --- |
   | `GARMIN_API_KEY` | your key from step 1 | Secret |
   | `OWNER_PASSPHRASE` | your passphrase from step 2 | Secret |
   | `TIMEZONE` | your time zone, e.g. `Europe/Copenhagen` or `America/New_York` | Text |

7. Find your Worker's address on its overview page, for example
   `https://garmin-mcp.yourname.workers.dev`. Open it in your browser. You should
   see `Private Garmin MCP server.` If you see `Not configured`, a secret or the
   KV binding is missing.

### 4. Connect Claude

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Name: `Garmin`. URL: your Worker's address with `/mcp` on the end, for example
   `https://garmin-mcp.yourname.workers.dev/mcp`.
3. Click **Add**, then **Connect**. Your Worker's sign-in page opens. Enter your
   owner passphrase and choose **Allow read-only access**.

The connector then works in Claude on the web, desktop and phone. In the
connector's settings you can set each tool to **Always** or **Ask**.

Try: *"How did I sleep this week?"* or *"Compare my resting heart rate this month
with last month."*

## Updating

When this repo gets a new version, open your Worker in Cloudflare, click **Edit
code**, replace everything in `worker.js` with the new [`src/index.js`](src/index.js)
and click **Deploy**. Your key, passphrase and storage stay as they are. If the
new version adds or renames tools, disconnect and reconnect the connector in
Claude so it picks them up.

## Tools

Each tool reads one part of Garmin's Personal API. Together they cover every
endpoint in it.

| Tool | Returns |
| --- | --- |
| Activities | Activities in a date range: distance, time, pace, heart rate, time in each heart-rate zone, training effect and load. Takes Garmin's search filters. |
| Activity details | One activity in full, with laps and splits |
| Activity workouts | The structured workout you followed in an activity, step by step |
| Activity file (FIT) | The original file your watch recorded, as a download |
| Wellness activities | Activities Garmin records outside workouts |
| Daily summaries | One row per day: steps, resting heart rate, calories, intensity minutes, stress, Body Battery, breathing, SpO2 |
| Day details | Garmin's full wellness summary for one day |
| Daily steps | Steps, distance and step goal per day |
| Daily stress | Stress level and time at each stress level per day |
| Body Battery | Charged, drained, highest and lowest per day, plus every reading |
| Heart rate (one day) | A reading about every two minutes |
| Heart-rate variability | Nightly HRV, 7-day average, baseline and status |
| HRV readings (one night) | Every 5-minute HRV reading |
| Blood oxygen (one day) | Hourly SpO2 averages and the day's figures |
| Sleep | One row per night: score, stages, heart rate, breathing, SpO2 |
| Sleep (one night) | Everything Garmin has on one night |
| Weigh-ins | Every weigh-in with BMI and body composition |
| Weight by day | Lowest, highest and latest weight per day |
| Weight goal | Your weight goal |
| Fitness age | Fitness age, achievable fitness age and what drives it |
| Heart-rate zones | Your zones per sport |
| Hydration | Water logged per day |
| Nutrition log | Food logged for one day |
| Profile settings | Units, time zone, training days |
| Menstrual cycle summary | Cycle summary for a date |
| Menstrual cycle day | Detailed cycle view for one day |

Dates are `YYYY-MM-DD` in your own time zone. Range tools accept an optional
`fields` list, so an app can ask for only the columns it needs.

## Security

- **Read-only.** Garmin's Personal API can't change, delete or post anything.
- **Only you can connect.** Connecting requires your owner passphrase. After 10
  wrong attempts in a day, sign-in locks until midnight UTC.
- **Sign-ins only go to approved apps.** By default the Worker sends sign-ins only
  to `claude.ai` and `claude.com`.
- **Your Garmin key stays secret.** It lives in a Cloudflare secret, and the Worker
  sends it only to Garmin's token service.
- **Tokens are stored hashed.** Someone who could read your KV storage still
  couldn't use the sign-in tokens in it.
- **Fewer personal details.** The Worker removes GPS coordinates, routes, other
  people's names and likes, and account IDs from answers. "Activity details" can
  include start and end coordinates if you ask for them.
- **Cached answers.** To spare Garmin's rate limit, the Worker keeps answers in
  memory for 5 minutes. It also stores answers that cover only past days in your
  KV for 6 hours. Only your Worker can read them.

### Kill switches

| To | Do this |
| --- | --- |
| Stop all Garmin access at once | Delete the key in Garmin Connect → Settings → Personal API Key |
| Sign every connected app out | Under **Settings → Variables and Secrets**, add a Text variable `TOKEN_VERSION` with a new value (e.g. `2`), or change it if it exists |
| Remove everything | Delete the Worker and the `OAUTH_KV` namespace in Cloudflare |

## Other MCP clients

The Worker speaks standard MCP (Streamable HTTP) with OAuth 2.1, dynamic client
registration and PKCE, so other MCP clients can use it too. Add the host your
client sends sign-ins back to as a Text variable under **Settings → Variables
and Secrets**: `ALLOWED_REDIRECT_HOSTS`, comma separated. Keep the defaults in the
list, for example `claude.ai,claude.com,app.example.com`. For a client that signs in
through `localhost`, such as some desktop and command-line apps, also add
`ALLOW_LOCALHOST_REDIRECTS` with the value `true`. Every client still needs your
passphrase to connect.

## Cost

Nothing, for one person. Cloudflare's free plan allows 100,000 Worker requests a
day, and Garmin's Personal API and Claude's custom connectors cost nothing extra.
Cloudflare doesn't bill a free account when it hits a limit: requests fail until
the next day.

## Limits

- Garmin's Personal API is for one person's own data. For apps that serve other
  people, Garmin points to its
  [Developer Program](https://developer.garmin.com/gc-developer-program/overview/).
  Run one Worker per person.
- Garmin's Personal API has no endpoints for training status, race predictions or
  VO2 max history, and activities come back without their VO2 max value.
- Garmin keys expire after at most a year. Create a new one and replace the
  `GARMIN_API_KEY` secret.
- Garmin limits how fast you can call it. The Worker waits and retries when Garmin
  answers 429, and caching keeps repeat questions cheap.
- Blood oxygen for the current day can fail early in the morning, before Garmin has
  readings for it. Earlier days work.

## Troubleshooting

| You see | Fix |
| --- | --- |
| `Not configured` at the Worker's address | Add both secrets and the `OAUTH_KV` binding, then deploy |
| "Garmin rejected the API key" | The key expired or was deleted. Create a new one and replace `GARMIN_API_KEY` |
| "Garmin is rate-limiting requests" | Wait a few minutes and ask again |
| "Redirect URI not allowed" on the sign-in page | Your app's host is missing from `ALLOWED_REDIRECT_HOSTS` |
| "Too many attempts" | Sign-in locks for the rest of the UTC day after 10 wrong passphrases |
| New tools don't show up after an update | Disconnect and reconnect the connector in Claude |

## Development

You only need this to work on the code, not to use it. With Node.js 20 or newer:

```sh
npm test
```

The tests run the Worker in Node.js against a simulated Garmin and a simulated
OAuth client. They cover the sign-in flow, every tool, input checks, caching and
retries.

## License

MIT. This project is not affiliated with Garmin or Anthropic.
