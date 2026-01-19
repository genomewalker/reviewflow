#!/usr/bin/env python3
"""
Export reviewer responses to Word document with track changes support.
This script generates a formatted response document from the review JSON data.
"""

import json
import sys
from pathlib import Path
from datetime import datetime

def load_review_data(json_path):
    """Load review data from JSON file."""
    with open(json_path, 'r') as f:
        return json.load(f)

def generate_response_markdown(data, include_completed=True, include_draft=False, include_original=True):
    """Generate markdown content for responses."""
    output = []
    output.append(f"# Response to Reviewers\n")
    output.append(f"**Manuscript:** {data['manuscript']['title']}\n")
    output.append(f"**Authors:** {data['manuscript']['authors']}\n")
    output.append(f"**Date:** {datetime.now().strftime('%Y-%m-%d')}\n")
    output.append("---\n")

    for reviewer in data['reviewers']:
        output.append(f"\n## {reviewer['name']}\n")
        output.append(f"*Expertise: {reviewer['expertise']}*\n")
        output.append(f"*Assessment: {reviewer['overall_assessment']}*\n\n")

        for comment in reviewer['comments']:
            # Filter based on status
            if comment['status'] == 'completed' and include_completed:
                pass
            elif comment['status'] != 'completed' and include_draft:
                pass
            else:
                continue

            output.append(f"### Comment {comment['id']} ({comment['type'].upper()}, {comment['priority']} priority)\n")
            output.append(f"**Location:** {comment['location']}\n")
            output.append(f"**Category:** {comment['category']}\n\n")

            if include_original:
                output.append(f"**Reviewer Comment:**\n")
                output.append(f"> {comment['original_text']}\n\n")

            if comment.get('draft_response'):
                output.append(f"**Our Response:**\n")
                output.append(f"{comment['draft_response']}\n\n")

            if comment.get('requires_new_analysis') and comment.get('analysis_type'):
                output.append(f"*Required analyses: {', '.join(comment['analysis_type'])}*\n\n")

            output.append("---\n")

    return '\n'.join(output)

def generate_track_changes_script(data, manuscript_path):
    """Generate a script for applying track changes to the manuscript."""
    changes = []

    for reviewer in data['reviewers']:
        for comment in reviewer['comments']:
            if comment['status'] == 'completed' and comment.get('draft_response'):
                # Extract any specific text changes from the response
                changes.append({
                    'comment_id': comment['id'],
                    'location': comment['location'],
                    'category': comment['category'],
                    'response': comment['draft_response']
                })

    return changes

def main():
    if len(sys.argv) < 2:
        print("Usage: python export_responses.py <review_data.json> [output.md]")
        sys.exit(1)

    json_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else 'response_to_reviewers.md'

    data = load_review_data(json_path)
    markdown = generate_response_markdown(data)

    with open(output_path, 'w') as f:
        f.write(markdown)

    print(f"Response document generated: {output_path}")

    # Generate statistics
    all_comments = [c for r in data['reviewers'] for c in r['comments']]
    completed = len([c for c in all_comments if c['status'] == 'completed'])
    total = len(all_comments)
    print(f"Progress: {completed}/{total} comments addressed ({100*completed//total}%)")

if __name__ == '__main__':
    main()
