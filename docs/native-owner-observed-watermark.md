# Native owner observation watermark

Refs #300, #46 (NP-04), #47 (NP-05), #42.

`lastObservedSeq` records the highest valid native sequence seen within one
managed owner/generation. It is an observation watermark, not proof that the
preceding history is complete, cached by the browser, or projected. It does
not authorize resending an input whose native result is uncertain.

The update compares and writes the sequence in one SQLite statement. Older
or duplicate frames cannot lower it, including observations from another
SQLite connection. Missing, negative, fractional, non-finite and unsafe
integer values do not replace it. Raw envelopes retain their original
sequence and disposition; no frame is discarded by this change.

Native turn tracking remains independent. Existing owner/Host/generation
checks still control writes, and acquiring a new generation clears the old
observation watermark. Sequence reset and native process restart still need
the existing lifecycle and native reconciliation contracts; a low sequence
alone does not prove a new generation or completion.

Directed verification uses the actual manager frame sink, SQLite reopening,
transaction rollback and two real concurrent Node writer processes with
100 observations. Existing owner single-flight, SIGKILL recovery, native
capture and delayed failure regressions check compatibility. These are
controlled local inputs, not new official Agent or provider trajectories.
