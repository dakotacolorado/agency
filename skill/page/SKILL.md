---
name: page
description: Tell the person whether you need them. Use before you end every turn, and whenever you start waiting on them, to say in one line that you are working (including waiting on your own subagents or background work) or waiting on them, and what for.
---

# Page

The person sees one line for each agent, and is notified only when a agent
is **waiting** on them. From outside, a turn that ends on a question, one that
ends with the work done and one that ends to wait on your own subagents all
look the same, so you say which it is.

## Calling it

Run `"$CLAUDE_CONFIG_DIR/skills/page/bin/page"` (called `page` below):

```sh
page working 'Waiting on 3 review subagents for PR #41' 'Reviewing PR #41'
page waiting 'Which schema should the status field use?' 'Asks: status schema'
page waiting 'The criteria on #41 conflict on the retry limit: 3 or 5?' 'Asks: retry limit'
page review 'PR #41 is submitted to the release service; the ticket is in review' 'In review: PR #41'
page done 'Answered: the queue holds 3 PRs, none failing' 'Answered: queue'
```

The line is at most 280 characters. While working, say what you are doing.
While waiting, say what you need from the person, so they can answer from the
line alone.

Give a headline every time, as the third argument: the line in a few words,
at most 29 characters, that a person can scan in a list of agents. It shows
on your card; the whole line shows on your page. It goes with the line, so a
page without one leaves you with none.

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
  your next tool call, and carry on. The console shows your latest activity
  over the page line once you act again, so the person may see only your
  reply: a question in the page line alone can go unseen.
- **In review**, once your change is submitted to the release service and its
  item moved to `review`: page `review`, saying what you submitted. You are
  waiting on the reviewer, not the person, and it does not notify them. A
  agent in review is kept, not retired, so a send-back still reaches you;
  page it last.
- **An epic ready for sign-off**: the person closes an epic, never you, from
  its review panel. Ask for it only once every story and task under it reads
  `done` or is closed (finish what is open, or close it `not_planned` with the
  reason on its work log); while any of its PRs is still with the release service,
  page `review`. Then page `waiting` with one line naming the epic by its short
  id, which links the person to the panel:
  `page waiting '00019346 is ready for sign-off: all 3 stories done and in prod' 'Ready: 00019346'`.
- **Done**, when you have finished what was asked, need no review, and have
  nothing left to do or running: page `done`, with the result in one line. Work
  that changes a repo is never `done` from you: it is `review` until merged. A
  agent made to stop or retire once done is stopped then, so page it last,
  with nothing left to do. Done does not notify the person; if you need them, page `waiting`
  instead.
- A message from the person makes you `working` again by itself.

## Ask in your reply

Ask the person in the text of your reply, after paging `waiting`.

The page line is not your reply. Ending `done` or `review`, write the answer,
or what you submitted, in your reply first, then page last: the line only
says it in brief.
