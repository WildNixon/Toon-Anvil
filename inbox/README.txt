DROP YOUR HOMEBREW HERE
=======================

This folder is yours. Put a subclass file in it and reload Toon Anvil in the
browser — it will appear in the Library, ready to analyse.

Nothing else writes to this folder. Your files are never moved, renamed,
edited or deleted. Extraction output goes to ../library/, not back in here.


WHAT YOU CAN DROP
-----------------

  .pdf         a homebrew PDF, or a whole compendium of them
  .html/.htm   a saved page (GM Binder, Homebrewery, a wiki export)
  .md          Markdown, including Homebrewery source
  .json        Toon Anvil's own export format
  .txt         plain text — works, but expect to fix some mappings by hand

Both level phrasings are understood:  "Level 3:"  and  "At 3rd level".


WHAT HAPPENS TO A PDF
---------------------

Drop it, reload the app, and it is split automatically. You do not have to run
anything. The pieces land in:

    ../library/extracted/<name of your PDF>/

grouped into subclasses, spells, magic items and feats. A big compendium can
take a few seconds the first time; after that it is remembered and never
re-split. It is tracked by file contents, so renaming the PDF will not make it
process twice, and re-dropping the same file does nothing.

If you would rather run it yourself:

    python tools/split_pdf.py


IF SOMETHING DOESN'T PARSE
--------------------------

Every analysis reports a coverage number: how much of the subclass the app
actually understood. Low coverage is information, not silent failure — the
report names exactly which features it could not map, so you can fix the
wording or map them by hand in the app.

PDFs are the lowest-fidelity path because text extraction loses layout. If a
PDF maps poorly, saving the source page as HTML usually works much better.


ONE THING TO KNOW
-----------------

If you analyse content you do not have the rights to redistribute, the page
Toon Anvil produces embeds that text — so that output is not yours to publish
either. Analysing it locally is fine; publishing the result is a separate
question.
