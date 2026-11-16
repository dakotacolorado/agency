---
name: page
description: Set whether you are working, waiting on the person, in review or done, with a headline for your card. Use before you end every turn, and whenever you start waiting on the person. It is a status flag, not where the person reads anything: your question goes in full in the reply that ends your turn.
---

# Page

The page is a status flag. It sets whether you are working (including waiting
on your own subagents or background work), waiting on the person, in review or
done, with a short line and a headline for your card. It notifies the person
only when you are **waiting**, and it sorts the list of agents.

The person does not read the line. The console shows your latest action over
it, so the reply that ends your turn replaces it within a second, and their
next message clears it. Everything the person must read, the question, its
options and links, goes in full in that reply.

## Calling it

Run `"$CLAUDE_CONFIG_DIR/skills/page/bin/page"` (called `page` below):

```sh
page working 'Waiting on 3 review subagents for PR #41' 'Reviewing PR #41'
page waiting 'Asking which schema the status field uses' 'Asks: status schema'
page waiting 'Asking about the retry limit: the criteria on #41 conflict' 'Asks: retry limit'
page review 'PR #41 is open for the reviewer the person asked for' 'In review: PR #41'
page done 'Answered: the queue holds 3 PRs, none failing' 'Answered: queue'
```

For each `waiting` above, the reply that follows asks the question in full:
which schemas, what each means, the criteria that conflict and links to them.

Keep the line short, at most 280 characters: what you are on, or what you are
asking about.

Give a headline every time, as the third argument: the line in a few words,
at most 29 characters, that a person can scan in a list of agents. It shows
on your card. It goes with the line, so a page without one leaves you with
none.

## When

- **When a turn starts**, as soon as you know what the person asked, page
  `working` and say what you are doing. A message from the person clears your
  line, so until you page the console shows "Nothing said yet".
- **Before you end every turn**, page once. A turn that ends with nothing paged
  since the last one ended shows as waiting on the person, with "Ended its turn
  without saying why".
- **Waiting on your own subagents or background work:** page `working`, and say
  what is running.
- **Waiting on the person**, with a question, a decision, or work for them to
  check: page `waiting`. Page only when you can't go on without them.
- **Mid-turn**, when you need the person but can keep working on something
  else, page `waiting`, then write the question in your reply, in full, before
  your next tool call, and carry on.
- **Shipping your own change**: while you wait out another agent's deploy, or
  follow your own deploy run, page `working`, naming the PR and the run.
- **In review**, only when the person has asked for a review of your PR before
  you merge it: page `review`, naming the PR. This does not notify them. An
  agent in review is kept, not deleted, so a send-back still reaches you.
- **An epic ready for sign-off**: the person closes an epic, never you, from
  its review panel. Ask for it only once every story and task under it reads
  `done` or is closed (finish what is open, or close it `not_planned` with the
  reason on its work log); while any of its PRs is not yet merged and deployed,
  ship it first. Then page `waiting` naming the epic by its short id,
  `page waiting '00019346 is ready for sign-off' 'Ready: 00019346'`, and in
  your reply name the epic, say what shipped, and give the link to its panel.
- **Done**, when you have finished what was asked, need no review, and have
  nothing left to do or running: page `done`, with the result in one line. Work
  that changes a repo is `done` only once merged and its deploy succeeded. An
  agent made to stop or delete once done is stopped once its turn ends, so
  leave nothing to do after it. Done does not notify the person; if you need
  them, page `waiting` instead.
- A message from the person makes you `working` again by itself.

## Page, then reply

Whatever the status, the order is the same: page, then end the turn with a
reply that stands on its own. Waiting, the reply holds the whole question, its
options and links. Done or in review, it holds the answer, or what you shipped
or submitted and where to look.

Never end on a reply that points elsewhere ("my choices above", "see the
page"): the person may see only that reply.
