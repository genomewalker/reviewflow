# Extract Peer Review Comments

Extract and classify reviewer comments from academic peer review documents.

## CRITICAL: Document Parsing Instructions

**IMPORTANT**: Peer review comments are written as REGULAR TEXT in the document body - NOT as Word comment annotations or tracked changes.

DO NOT look for:
- word/comments.xml (Word comment annotations)
- Tracked changes or revisions
- Sidebar comments

INSTEAD, parse the main document body text looking for reviewer sections and feedback paragraphs.

## Supported Formats

- Journal decision letters with referee comments
- Review reports (Reviewer 1, Reviewer 2, etc.)
- Editorial feedback
- Conference paper reviews
- Any document with structured reviewer feedback as plain text

## How to Identify Reviewers

Parse the document body for these patterns:
- "Referee #1", "Referee #2", "Reviewer 1", "Reviewer A"
- "Referee #1 (Remarks to the Author):"
- "Associate Editor", "Editor", "AE Comments"
- "Major Comments:", "Minor Comments:", "General Comments:"
- "REVIEWER REPORT", "Review of manuscript"
- Numbered or bulleted feedback sections following reviewer headers

## Parsing Strategy

1. Read the full document body text
2. Split into sections by reviewer headers
3. Within each reviewer section, identify individual comments:
   - Numbered points (1., 2., 3. or (1), (2), (3))
   - Bulleted items
   - "Line X:" or "Page X, Line Y:" references
   - Paragraph breaks between distinct topics
4. Classify each comment as major or minor

## Classification Rules

### MAJOR (~30% of comments)
Comments that could affect acceptance:
- Challenge validity of methodology or results
- Question interpretation or conclusions
- Request new experiments or analyses
- Raise reproducibility or rigor concerns
- Identify fundamental scientific issues
- Suggest the paper doesn't meet journal standards

### MINOR (~70% of comments)
Comments requiring smaller fixes:
- Clarification requests
- Citation/reference issues
- Terminology suggestions
- Figure/table improvements
- Formatting, typos, grammar
- Parameter/version requests
- Line-specific editorial corrections

## CRITICAL: Grouping Rules

**TARGET: ~15-25 major comments and ~35-50 minor comments per paper (total ~50-75)**

### Aggressive Grouping Required:

1. **Line-specific edits MUST be grouped**: When a reviewer lists multiple "Line X:" comments in sequence or within the same paragraph, combine them into ONE comment:
   - "Line 100: fix typo, Line 102: add citation, Line 105: clarify term" = 1 minor comment
   - All comments under a "Minor:" header = group by category (citations, typos, figures)

2. **Group by category within each reviewer section**:
   - All citation requests → 1-2 comments
   - All formatting/typo fixes → 1 comment
   - All figure improvements → 1 comment
   - All clarification requests about similar topics → 1 comment

3. **Keep separate only when scientifically distinct**:
   - Each major methodological concern = separate major comment
   - Each unique request for new analysis = separate major comment
   - Different figures with different issues = can be separate

4. **Skip entirely**:
   - Pure praise without actionable feedback
   - "Co-reviewed" statements with no substantive comments

### Example of proper grouping:

If reviewer says:
```
Line 100: cite TAD80 correctly
Line 105: add version number
Line 622: cite fastp
Line 633: cite meta-SourceTracker
Line 636: cite decOM
```

This becomes ONE minor comment:
```
{
  "type": "minor",
  "category": "Citation",
  "text": "Multiple citation corrections needed: Line 100 (TAD80), Line 105 (add version), Line 622 (fastp), Line 633 (meta-SourceTracker), Line 636 (decOM)",
  "summary": "Citation and version corrections at multiple lines"
}
```

NOT 5 separate comments!

## Output JSON

```json
{
  "reviewers": [
    {
      "id": "R1",
      "name": "Reviewer 1",
      "comments": [
        {
          "id": "R1-1",
          "type": "major|minor",
          "category": "Methodology|Results|Interpretation|Citation|Clarity|Figure|Formatting",
          "text": "original comment text from document",
          "summary": "brief 1-sentence summary"
        }
      ]
    }
  ],
  "summary": {
    "total": 0,
    "major": 0,
    "minor": 0
  }
}
```

## Example Extraction

Input document text:
```
Referee #1 (Remarks to the Author):
This is an interesting study. However, I have concerns about the methodology.

1. The sample size is too small to draw meaningful conclusions. Please provide power analysis.

2. Line 45: typo "teh" should be "the"
Line 48: missing period
Line 52: capitalize "figure"

3. The statistical analysis does not account for multiple comparisons.
```

Expected output:
```json
{
  "reviewers": [{
    "id": "R1",
    "name": "Referee #1",
    "comments": [
      {
        "id": "R1-1",
        "type": "major",
        "category": "Methodology",
        "text": "The sample size is too small to draw meaningful conclusions. Please provide power analysis.",
        "summary": "Sample size insufficient, needs power analysis"
      },
      {
        "id": "R1-2",
        "type": "minor",
        "category": "Formatting",
        "text": "Line 45: typo \"teh\" should be \"the\"\nLine 48: missing period\nLine 52: capitalize \"figure\"",
        "summary": "Multiple minor typos and formatting fixes on lines 45, 48, 52"
      },
      {
        "id": "R1-3",
        "type": "major",
        "category": "Methodology",
        "text": "The statistical analysis does not account for multiple comparisons.",
        "summary": "Statistical analysis lacks multiple comparison correction"
      }
    ]
  }],
  "summary": {"total": 3, "major": 2, "minor": 1}
}
```
