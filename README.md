# Rebuttr

<p align="center">
  <img src="docs/assets/logo.svg" alt="Rebuttr Logo" width="120">
</p>

<h3 align="center">AI-Powered Peer Review Response Platform</h3>

<p align="center">
  Streamline your manuscript revision workflow with intelligent response generation
</p>

<p align="center">
  <a href="https://genomewalker.github.io/rebuttr">Documentation</a> •
  <a href="https://genomewalker.github.io/rebuttr/tutorial">Tutorial</a> •
  <a href="https://github.com/genomewalker/rebuttr/issues">Issues</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/rebuttr?color=blue" alt="npm version">
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen" alt="node version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platforms">
  <img src="https://img.shields.io/github/license/genomewalker/rebuttr" alt="license">
</p>

---

## Why Rebuttr?

Responding to peer review comments is one of the most time-consuming parts of academic publishing. Rebuttr helps you:

- **Organize** all reviewer comments in one place
- **Generate** intelligent draft responses using AI
- **Track** your progress across multiple reviewers
- **Collaborate** with AI "expert panels" for complex technical questions
- **Export** polished responses ready for resubmission

## Features

| Feature | Description |
|---------|-------------|
| **Multi-Paper Management** | Handle multiple manuscripts simultaneously |
| **AI-Assisted Drafts** | Generate contextual responses using Claude/GPT |
| **Expert Panel** | Virtual experts discuss complex comments |
| **Potential Solutions** | Get multiple response strategies per comment |
| **Progress Dashboard** | Visual tracking of completion status |
| **Smart Import** | Parse reviews from PDF, DOCX, or plain text |
| **Export to Word** | Generate formatted response documents |

## Quick Start

### Prerequisites

- **Node.js 18+** ([Download](https://nodejs.org/))
- **OpenCode CLI** (for AI features)

```bash
npm i -g opencode-ai
```

### Installation

```bash
# Install globally from GitHub
npm i -g github:genomewalker/rebuttr

# Or clone and install locally
git clone https://github.com/genomewalker/rebuttr.git
cd rebuttr
npm install
npm link
```

### Launch

```bash
rebuttr
```

This starts the server and opens your browser to `http://localhost:3001`

## Usage

### Adding Your First Paper

**Option 1: Interactive CLI**
```bash
rebuttr papers add
```

**Option 2: Import JSON**
```bash
rebuttr papers import reviews.json
```

**Option 3: Web Interface**
1. Open Rebuttr in your browser
2. Click "Add Paper"
3. Paste or upload your reviewer comments

### Working with Comments

1. **Select a paper** from the dropdown
2. **Browse comments** organized by reviewer
3. **Click a comment** to view details and generate responses
4. **Use AI assistance** to draft responses
5. **Edit and finalize** your responses
6. **Track progress** on the dashboard

### CLI Reference

```bash
rebuttr                      # Launch (server + browser)
rebuttr start                # Server only (foreground)
rebuttr stop                 # Stop server
rebuttr status               # Check server status
rebuttr restart              # Restart server

rebuttr papers               # List all papers
rebuttr papers add           # Add interactively
rebuttr papers import <file> # Import from JSON
rebuttr papers open <id>     # Open specific paper
rebuttr papers remove <id>   # Archive paper

rebuttr config               # Show configuration
rebuttr config set <k> <v>   # Set config value
rebuttr init                 # Initialize database
rebuttr skills list          # List installed AI skills
rebuttr skills install       # Install/update skills
rebuttr help                 # Show help
```

## Configuration

Configuration is stored in `~/.config/rebuttr/config.json`:

```json
{
  "projectFolder": "~/Rebuttr",
  "server": {
    "port": 3001
  },
  "opencode": {
    "model": "sonnet",
    "variant": "high"
  }
}
```

Set values via CLI:
```bash
rebuttr config set server.port 3002
rebuttr config set opencode.model opus
```

## Data Storage

All data is stored locally in `~/Rebuttr/`:

```
~/Rebuttr/
├── data/
│   ├── review_platform.db    # SQLite database
│   └── papers/               # Per-paper files
├── input/                    # Import staging
├── output/                   # Exported documents
└── sessions/                 # Session data
```

## AI Expert Skills

Rebuttr includes specialized AI skills installed to `~/.config/opencode/skill/`:

| Skill | Expertise |
|-------|-----------|
| `methodology-expert` | Research design, experimental methods |
| `statistical-expert` | Statistical analysis, data interpretation |
| `literature-expert` | Citations, literature synthesis |
| `writing-expert` | Scientific writing, clarity, structure |

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥18.0.0 | With native module support |
| npm | ≥8.0.0 | Included with Node.js |
| OpenCode CLI | Latest | For AI features |

### Platform-Specific Notes

**macOS**: Requires Xcode Command Line Tools
```bash
xcode-select --install
```

**Linux (Debian/Ubuntu)**: Requires build tools
```bash
sudo apt-get install build-essential python3
```

**Windows**: Requires Visual Studio Build Tools
```bash
npm install -g windows-build-tools
```

## Troubleshooting

### Native module compilation fails

```bash
# Rebuild better-sqlite3
npm rebuild better-sqlite3

# If that fails, ensure build tools are installed (see above)
```

### Server won't start

```bash
# Check if port is in use
lsof -i :3001

# Use different port
rebuttr config set server.port 3002
```

### AI features not working

```bash
# Verify OpenCode is installed
opencode --version

# Check API key is configured
opencode config
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) first.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Built with [OpenCode](https://github.com/anthropics/opencode) by Anthropic
- SQLite bindings by [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- Icons by [Font Awesome](https://fontawesome.com/)

---

<p align="center">
  Made with ☕ for researchers everywhere
</p>
