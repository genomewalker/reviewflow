# Extract Reviews Skill

Extracts and classifies peer review comments from academic review documents.

## Overview

This skill reads peer review documents (DOCX, PDF, or text) and extracts structured reviewer comments with proper major/minor classification.

## Classification Rules

### MAJOR Comments (~15-25 per paper)
Comments that require substantial revision or could affect acceptance:
- Challenge the validity of methodology or experimental design
- Question the interpretation of results or conclusions
- Request additional experiments, analyses, or data
- Raise concerns about scientific rigor, reproducibility, or controls
- Suggest fundamental flaws in the approach
- Question whether claims are supported by evidence

### MINOR Comments (~35-50 per paper)
Comments that require small fixes or clarifications:
- Editorial corrections (typos, grammar, punctuation)
- Citation issues (missing references, wrong citations)
- Clarification requests for specific lines or figures
- Terminology suggestions
- Figure/table improvements (legends, labels, colors)
- Formatting issues
- Version numbers, parameters to add
- Small rephrasing suggestions

## Grouping Rules

1. **Group sequential line edits**: Multiple "Line X: ..." comments addressing similar issues (typos, citations, formatting) should be combined into ONE minor comment
2. **Keep substantive comments separate**: Each distinct scientific concern gets its own comment
3. **Preserve reviewer attribution**: Always track which referee made each comment

## Output Format

```json
{
  "reviewers": [
    {
      "id": "R1",
      "name": "Referee #1",
      "expertise": "inferred from comments",
      "sentiment": "positive|neutral|critical",
      "comments": [
        {
          "id": "R1-1",
          "type": "major",
          "category": "Methodology|Results|Interpretation|...",
          "text": "Original comment text",
          "summary": "Brief 1-sentence summary",
          "lines_referenced": ["Line 100", "Line 105"]
        }
      ]
    }
  ],
  "summary": {
    "total": 60,
    "major": 19,
    "minor": 41
  }
}
```

## Usage

```
@use extract-reviews

Extract and classify reviewer comments from [filename]
```
