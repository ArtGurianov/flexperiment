# Recovery branch topology

Keep controller code, repair identity, and promotion identity separate:

```text
candidate
   |
 repair
   |\
   | controller fixes
   |
 promotion
```

A controller ref may advance independently and may contain the repair in its
history. The repair identity remains the exact adopted SHA. Promotion is built
directly on repair, uses its own immutable ref, and must prove
`promotion^ == repair`.

The following topology is invalid:

```text
repair -> controller-only commits -> promotion
```

It contaminates the `repair..promotion` scope with controller changes, making
the canonical legal-promotion boundary impossible to prove. A promotion must
not be built atop controller commits or unrelated `main` commits.

See [legal cutover recovery](LEGAL_CUTOVER_RECOVERY.md).
