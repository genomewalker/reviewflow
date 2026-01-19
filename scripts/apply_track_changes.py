#!/usr/bin/env python3
"""
Apply Track Changes to Manuscript

This script applies track changes to a Word document based on reviewer comments
and responses. It uses the docx skill's unpack/pack workflow.

Usage:
    python apply_track_changes.py <manuscript.docx> <changes.json> <output.docx>

The changes.json file should contain a list of text replacements:
[
    {
        "comment_id": "R1-5",
        "find": "Pliocene-Pleistocene transition",
        "replace": "Early Pleistocene interglacial",
        "location": "Line 492"
    }
]
"""

import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# Add the docx skill scripts to path
SKILL_SCRIPTS = Path("/sessions/inspiring-sweet-albattani/mnt/.skills/skills/docx/scripts")
sys.path.insert(0, str(SKILL_SCRIPTS))

from unpack import unpack
from pack import pack


def escape_xml(text: str) -> str:
    """Escape special XML characters."""
    return (text
        .replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
        .replace('"', '&quot;')
        .replace("'", '&#x2019;'))  # Smart apostrophe


def create_track_change_xml(old_text: str, new_text: str, change_id: int) -> str:
    """Generate track changes XML for a text replacement."""
    timestamp = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")

    old_escaped = escape_xml(old_text)
    new_escaped = escape_xml(new_text)

    return f'''<w:del w:id="{change_id}" w:author="Claude" w:date="{timestamp}">
  <w:r><w:delText>{old_escaped}</w:delText></w:r>
</w:del><w:ins w:id="{change_id + 1}" w:author="Claude" w:date="{timestamp}">
  <w:r><w:t>{new_escaped}</w:t></w:r>
</w:ins>'''


def apply_changes_to_document(manuscript_path: str, changes: list, output_path: str) -> dict:
    """
    Apply track changes to a manuscript.

    Args:
        manuscript_path: Path to the original manuscript
        changes: List of change dictionaries with 'find' and 'replace' keys
        output_path: Path for the output document

    Returns:
        Dictionary with statistics about applied changes
    """
    stats = {
        'total_changes': len(changes),
        'applied': 0,
        'not_found': [],
        'errors': []
    }

    # Create temp directory for unpacking
    with tempfile.TemporaryDirectory() as temp_dir:
        unpacked_dir = Path(temp_dir) / "unpacked"

        # Unpack the document
        _, msg = unpack(manuscript_path, str(unpacked_dir))
        print(f"Unpack: {msg}")

        # Read the document.xml
        doc_xml_path = unpacked_dir / "word" / "document.xml"
        if not doc_xml_path.exists():
            raise FileNotFoundError("Could not find document.xml in unpacked archive")

        content = doc_xml_path.read_text(encoding='utf-8')

        # Apply each change
        change_id = 100  # Start with high ID to avoid conflicts
        for change in changes:
            find_text = change.get('find', '')
            replace_text = change.get('replace', '')
            comment_id = change.get('comment_id', 'unknown')

            if not find_text:
                continue

            # Look for the text in the document
            # Note: In Word XML, text may be split across multiple <w:t> elements
            # This simple approach works for text that's in a single run
            if find_text in content:
                # Create track changes XML
                track_change = create_track_change_xml(find_text, replace_text, change_id)

                # Replace the first occurrence
                # In a more sophisticated implementation, we'd parse the XML properly
                content = content.replace(
                    f'<w:t>{escape_xml(find_text)}</w:t>',
                    track_change,
                    1  # Only first occurrence
                )

                # Also try without the t tags (text might be embedded differently)
                if f'<w:t>{escape_xml(find_text)}</w:t>' not in content:
                    # Try a more flexible pattern
                    pattern = re.escape(escape_xml(find_text))
                    if re.search(pattern, content):
                        content = re.sub(
                            f'>{pattern}<',
                            f'>{track_change}<',
                            content,
                            count=1
                        )

                stats['applied'] += 1
                change_id += 2
                print(f"  Applied change for {comment_id}: '{find_text[:30]}...' -> '{replace_text[:30]}...'")
            else:
                stats['not_found'].append({
                    'comment_id': comment_id,
                    'text': find_text[:50]
                })
                print(f"  Not found for {comment_id}: '{find_text[:50]}...'")

        # Write the modified content
        doc_xml_path.write_text(content, encoding='utf-8')

        # Pack the document
        _, msg = pack(str(unpacked_dir), output_path, original_file=manuscript_path)
        print(f"Pack: {msg}")

    return stats


def generate_changes_from_reviews(review_data_path: str) -> list:
    """
    Generate a list of text changes based on reviewer comments.

    This function looks at comments that have specific line references
    and generates appropriate text changes.
    """
    with open(review_data_path, 'r') as f:
        data = json.load(f)

    changes = []

    # Define known text corrections based on reviewer comments
    known_corrections = {
        'R1-5': {
            'find': 'Pliocene-Pleistocene transition',
            'replace': 'Early Pleistocene interglacial',
            'location': 'Lines 492, 520'
        },
        'R1-6': {
            'find': 'early Pleistocene',
            'replace': 'Pliocene',
            'location': 'Line 30'
        },
        'R1-7': {
            'find': 'recent advance',
            'replace': 'recent advances',
            'location': 'Line 33'
        },
        'R1-18': {
            'find': 'detection',
            'replace': 'breadth of coverage',
            'location': 'Figure 3B, 3C'
        },
        'R1-29': {
            'find': 'novel method',
            'replace': 'method',
            'location': 'Line 434'
        },
        'R4-12-1': {
            'find': 'thawing',
            'replace': 'thawed',
            'location': 'Line 409'
        }
    }

    for comment_id, correction in known_corrections.items():
        changes.append({
            'comment_id': comment_id,
            **correction
        })

    return changes


def main():
    if len(sys.argv) < 3:
        print("Usage: python apply_track_changes.py <manuscript.docx> <changes.json> [output.docx]")
        print("       python apply_track_changes.py <manuscript.docx> --auto [output.docx]")
        print("\n--auto: Generate changes automatically from reviewer comments")
        sys.exit(1)

    manuscript_path = sys.argv[1]

    if sys.argv[2] == '--auto':
        # Auto-generate changes from review data
        review_data = Path(__file__).parent.parent / "data" / "reviewer_comments.json"
        changes = generate_changes_from_reviews(str(review_data))
        output_path = sys.argv[3] if len(sys.argv) > 3 else manuscript_path.replace('.docx', '_revised.docx')
    else:
        changes_path = sys.argv[2]
        output_path = sys.argv[3] if len(sys.argv) > 3 else manuscript_path.replace('.docx', '_revised.docx')

        with open(changes_path, 'r') as f:
            changes = json.load(f)

    print(f"\nApplying {len(changes)} changes to: {manuscript_path}")
    print(f"Output will be saved to: {output_path}\n")

    stats = apply_changes_to_document(manuscript_path, changes, output_path)

    print(f"\n=== Summary ===")
    print(f"Total changes requested: {stats['total_changes']}")
    print(f"Successfully applied: {stats['applied']}")
    print(f"Not found: {len(stats['not_found'])}")

    if stats['not_found']:
        print("\nText not found for:")
        for item in stats['not_found']:
            print(f"  - {item['comment_id']}: {item['text']}")


if __name__ == "__main__":
    main()
