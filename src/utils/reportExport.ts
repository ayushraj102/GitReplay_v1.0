import { jsPDF } from 'jspdf';
import { ArchitectureModule, GitCommit, GitRepository } from '../types/git';

function escapeTableCell(value: string): string {
  return (value || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function getRepoSummaryMeta(repo: GitRepository, annotations: Record<string, string>) {
  const commits = repo.commits || [];
  const authors = new Set(commits.map((c) => c.author).filter(Boolean));
  const firstDate = commits[0]?.timestamp?.split(' ')[0] || '-';
  const lastDate = commits[commits.length - 1]?.timestamp?.split(' ')[0] || '-';
  const dateRange = firstDate === lastDate ? firstDate : `${firstDate} to ${lastDate}`;
  const taggedCommit = [...commits].reverse().find((c) => c.tag);
  const currentVersion =
    taggedCommit?.tag || commits[commits.length - 1]?.shortSha || 'HEAD';
  const milestones = commits.filter((c) => c.isArchitecturalMilestone);
  const keyMilestones =
    milestones.length > 0 ? milestones.slice(0, 5) : commits.slice(0, 3);
  const latestCommit = commits[commits.length - 1];
  const latestModules = latestCommit?.adr?.modules || [];
  const latestEdges = latestCommit?.adr?.edges || [];
  const savedNoteCount = commits.filter((c) => Boolean(annotations[c.sha]?.trim())).length;

  return {
    commits,
    authors,
    dateRange,
    currentVersion,
    milestones,
    keyMilestones,
    latestModules,
    latestEdges,
    savedNoteCount,
  };
}

/**
 * Builds an easy-to-read Markdown onboarding guide for a repository.
 */
export function buildOnboardingMarkdown(
  repo: GitRepository,
  annotations: Record<string, string>
): string {
  const {
    commits,
    authors,
    dateRange,
    currentVersion,
    milestones,
    keyMilestones,
    latestModules,
    latestEdges,
    savedNoteCount,
  } = getRepoSummaryMeta(repo, annotations);

  const lines: string[] = [
    `# ${repo.owner}/${repo.name} — Onboarding Guide`,
    ``,
    repo.description ? `> ${repo.description}` : `> Code evolution & architecture walkthrough.`,
    ``,
    `## At a Glance`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| **Branch** | \`${escapeTableCell(repo.defaultBranch || 'main')}\` |`,
    `| **Primary Language** | ${escapeTableCell(repo.primaryLanguage || 'TypeScript')} |`,
    `| **Current Version** | \`${escapeTableCell(currentVersion)}\` |`,
    `| **Timeline Covered** | ${escapeTableCell(dateRange)} |`,
    `| **Commits / Contributors** | ${commits.length} commits · ${authors.size} contributor(s) |`,
    `| **Architectural Milestones** | ${milestones.length} |`,
    `| **Personal Notes** | ${savedNoteCount} |`,
    ``,
  ];

  if (keyMilestones.length > 0) {
    lines.push(`## Start Here: Key Milestones`);
    lines.push(``);
    lines.push(`Read these commits first to understand why the module is shaped the way it is today:`);
    lines.push(``);
    lines.push(`| Step | Commit | Tag | Change | Outcome |`);
    lines.push(`|------|--------|-----|--------|---------|`);
    keyMilestones.forEach((c) => {
      const stepNum = commits.findIndex((item) => item.sha === c.sha) + 1;
      lines.push(
        `| ${stepNum > 0 ? `#${stepNum}` : '-'} | \`${c.shortSha}\` | ${
          c.tag ? `\`${escapeTableCell(c.tag)}\`` : '-'
        } | **${escapeTableCell(c.title)}** | ${escapeTableCell(
          c.adr?.measurableOutcome || c.category
        )} |`
      );
    });
    lines.push(``);
  }

  if (latestModules.length > 0) {
    lines.push(`## Current Architecture Snapshot`);
    lines.push(``);
    const layerOrder: ArchitectureModule['layer'][] = ['client', 'edge', 'core', 'storage'];
    const layerLabels: Record<ArchitectureModule['layer'], string> = {
      client: 'Client / Interface',
      edge: 'Edge / Transport',
      core: 'Core / Execution',
      storage: 'Storage / State',
    };

    for (const layer of layerOrder) {
      const mods = latestModules.filter((m) => m.layer === layer);
      if (mods.length === 0) continue;
      lines.push(`### ${layerLabels[layer]}`);
      mods.forEach((m) => {
        const metrics = m.metrics ? ` — *${m.metrics}*` : '';
        lines.push(`- **${m.name}** (\`${m.status}\`)${metrics}: ${m.description}`);
      });
      lines.push(``);
    }

    if (latestEdges.length > 0) {
      const nameById = new Map(latestModules.map((m) => [m.id, m.name]));
      lines.push(`**Data Flow Connections**`);
      lines.push(``);
      latestEdges.forEach((edge) => {
        const fromName = nameById.get(edge.from) || edge.from;
        const toName = nameById.get(edge.to) || edge.to;
        const badge = edge.isNew ? ' *(updated in latest commit)*' : '';
        lines.push(`- \`${fromName}\` → \`${toName}\`: ${edge.protocol}${badge}`);
      });
      lines.push(``);
    }
  }

  lines.push(`## Step-by-Step Code Evolution (${commits.length} Commits)`);
  lines.push(``);

  commits.forEach((c: GitCommit, idx: number) => {
    const tagPart = c.tag ? ` · \`${c.tag}\`` : '';
    const milestonePart = c.isArchitecturalMilestone ? ` · **[Milestone]**` : '';
    const dateStr = c.timestamp ? c.timestamp.split(' ')[0] : '-';

    lines.push(`### Step ${idx + 1} of ${commits.length} · \`${c.shortSha}\` ${c.title}`);
    lines.push(``);
    lines.push(
      `**${c.category}**${tagPart}${milestonePart} · ${c.author}${
        c.authorRole ? ` (${c.authorRole})` : ''
      } · ${dateStr}`
    );
    lines.push(``);
    lines.push(`- **Why (Problem):** ${c.adr?.problemStatement || c.message || 'N/A'}`);
    lines.push(`- **What Changed (Decision):** ${c.adr?.decisionSummary || c.message || 'N/A'}`);

    if (c.adr?.tradeoffs && c.adr.tradeoffs.length > 0) {
      lines.push(`- **Trade-offs & Considerations:**`);
      c.adr.tradeoffs.forEach((t) => lines.push(`  - ${t}`));
    }

    if (c.adr?.measurableOutcome) {
      lines.push(`- **Outcome:** ${c.adr.measurableOutcome}`);
    }

    if (c.files && c.files.length > 0) {
      const filesList = c.files
        .slice(0, 8)
        .map((f) => `\`${f.path}\` (${f.status})`)
        .join(', ');
      const extra = c.files.length > 8 ? ` +${c.files.length - 8} more` : '';
      lines.push(`- **Files Touched:** ${filesList}${extra}`);
    }

    const note = annotations[c.sha]?.trim();
    if (note) {
      lines.push(``);
      lines.push(`> **Developer Note:** ${note}`);
    }

    lines.push(``);
    lines.push(`---`);
    lines.push(``);
  });

  return lines.join('\n');
}

/**
 * Generates and downloads the full Markdown onboarding guide.
 */
export function exportOnboardingMarkdown(
  repo: GitRepository,
  annotations: Record<string, string>
): void {
  const markdown = buildOnboardingMarkdown(repo, annotations);
  const blob = new Blob([markdown], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${repo.name}-gitreplay-guide.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Sanitizes characters outside standard WinAnsi range for jsPDF built-in Helvetica font.
 */
function pdfSafeText(text: string): string {
  return (text || '')
    .replace(/[—–]/g, '-')
    .replace(/·/g, '|')
    .replace(/→/g, '->')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Generates and downloads a clean, summarized PDF onboarding report for Day-1 engineers.
 */
export function exportOnboardingSummaryPdf(
  repo: GitRepository,
  annotations: Record<string, string>
): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 42;
  const contentWidth = pageWidth - marginX * 2;
  const bottomLimit = pageHeight - 48;

  // Warm neutral + amber palette matching GitReplay UI
  const COLORS = {
    ink: [26, 25, 24] as [number, number, number],
    body: [58, 55, 51] as [number, number, number],
    muted: [115, 110, 102] as [number, number, number],
    border: [226, 220, 210] as [number, number, number],
    surface: [250, 248, 244] as [number, number, number],
    amber: [184, 115, 34] as [number, number, number],
    amberBar: [224, 164, 88] as [number, number, number],
    amberSoftBg: [254, 247, 236] as [number, number, number],
    amberSoftBorder: [241, 212, 168] as [number, number, number],
    greenText: [42, 122, 75] as [number, number, number],
  };

  let y = 44;

  const ensureSpace = (neededPt: number) => {
    if (y + neededPt > bottomLimit) {
      doc.addPage();
      y = 44;
    }
  };

  const measureWrappedHeight = (
    text: string,
    maxWidth: number,
    lineHeight: number,
    fontSize: number,
    fontStyle: 'normal' | 'bold' = 'normal'
  ): { lines: string[]; height: number } => {
    doc.setFont('helvetica', fontStyle);
    doc.setFontSize(fontSize);
    const lines = doc.splitTextToSize(pdfSafeText(text), maxWidth) as string[];
    return { lines, height: Math.max(1, lines.length) * lineHeight };
  };

  const drawWrapped = (
    text: string,
    x: number,
    maxWidth: number,
    lineHeight: number,
    fontSize: number,
    color: [number, number, number],
    fontStyle: 'normal' | 'bold' = 'normal'
  ) => {
    doc.setFont('helvetica', fontStyle);
    doc.setFontSize(fontSize);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(pdfSafeText(text), maxWidth) as string[];
    for (const line of lines) {
      ensureSpace(lineHeight);
      doc.text(line, x, y);
      y += lineHeight;
    }
  };

  const drawSectionHeading = (title: string, subtitle?: string) => {
    ensureSpace(40);
    doc.setFillColor(...COLORS.amberBar);
    doc.rect(marginX, y - 10, 3, 14, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.setTextColor(...COLORS.ink);
    doc.text(pdfSafeText(title), marginX + 10, y + 1);
    y += 14;

    if (subtitle) {
      drawWrapped(subtitle, marginX + 10, contentWidth - 10, 12, 8.8, COLORS.muted, 'normal');
    }
    y += 4;
  };

  const {
    commits,
    authors,
    dateRange,
    currentVersion,
    keyMilestones,
    latestModules,
    latestEdges,
    savedNoteCount,
  } = getRepoSummaryMeta(repo, annotations);

  // --- Header Banner ---
  doc.setFillColor(...COLORS.amberBar);
  doc.rect(marginX, y - 14, contentWidth, 3, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...COLORS.amber);
  doc.text('GITREPLAY  |  DAY-1 CODEBASE ONBOARDING BRIEF', marginX, y);
  y += 18;

  drawWrapped(
    `${repo.owner}/${repo.name}`,
    marginX,
    contentWidth,
    24,
    20,
    COLORS.ink,
    'bold'
  );
  y += 2;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...COLORS.muted);
  doc.text(
    pdfSafeText(
      `Branch: ${repo.defaultBranch || 'main'}  |  Language: ${
        repo.primaryLanguage || 'TypeScript'
      }  |  Generated: ${new Date().toISOString().slice(0, 10)}`
    ),
    marginX,
    y
  );
  y += 14;

  doc.setDrawColor(...COLORS.border);
  doc.setLineWidth(0.8);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;

  if (repo.description) {
    drawWrapped(repo.description, marginX, contentWidth, 14, 10, COLORS.body, 'normal');
    y += 8;
  }

  // --- Key Stats Grid (2 rows x 2 columns so dates & versions never clip) ---
  ensureSpace(92);
  const cardGap = 10;
  const statWidth = (contentWidth - cardGap) / 2;
  const stats = [
    { label: 'COMMITS & CONTRIBUTORS', value: `${commits.length} commits across ${authors.size} contributor(s)` },
    { label: 'CURRENT VERSION / TAG', value: pdfSafeText(currentVersion) },
    { label: 'TIMELINE SPAN', value: pdfSafeText(dateRange) },
    {
      label: 'KEY MILESTONES & NOTES',
      value: `${keyMilestones.length} milestone(s) | ${savedNoteCount} saved note(s)`,
    },
  ];

  for (let row = 0; row < 2; row++) {
    const rowY = y;
    for (let col = 0; col < 2; col++) {
      const stat = stats[row * 2 + col];
      const bx = marginX + col * (statWidth + cardGap);
      doc.setFillColor(...COLORS.surface);
      doc.setDrawColor(...COLORS.border);
      doc.roundedRect(bx, rowY, statWidth, 38, 4, 4, 'FD');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      doc.setTextColor(...COLORS.muted);
      doc.text(stat.label, bx + 10, rowY + 13);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.5);
      doc.setTextColor(...COLORS.ink);
      const valLine = (doc.splitTextToSize(stat.value, statWidth - 20) as string[])[0] || '-';
      doc.text(valLine, bx + 10, rowY + 28);
    }
    y += 45;
  }
  y += 4;

  // --- Quick-Start Reading Guide Box ---
  ensureSpace(54);
  doc.setFillColor(...COLORS.amberSoftBg);
  doc.setDrawColor(...COLORS.amberSoftBorder);
  doc.roundedRect(marginX, y, contentWidth, 44, 5, 5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(...COLORS.amber);
  doc.text('HOW TO READ THIS GUIDE', marginX + 12, y + 15);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.8);
  doc.setTextColor(...COLORS.body);
  doc.text(
    '1. Review the module layers  ->  2. Read the key turning points  ->  3. Scan the commit-by-commit digest.',
    marginX + 12,
    y + 31,
    { maxWidth: contentWidth - 24 }
  );
  y += 58;

  let sectionNum = 1;

  // --- Section: Current Architecture Snapshot ---
  if (latestModules.length > 0) {
    drawSectionHeading(
      `${sectionNum++}. Current Architecture Snapshot`,
      'Main modules and data-flow links in the latest revision.'
    );

    for (const mod of latestModules.slice(0, 8)) {
      const metricPart = mod.metrics ? ` (${pdfSafeText(mod.metrics)})` : '';
      const header = `[${mod.layer.toUpperCase()}] ${mod.name}${metricPart} - ${mod.status}`;
      const desc = mod.description || '';
      const hMeas = measureWrappedHeight(header, contentWidth - 24, 12, 9.2, 'bold');
      const dMeas = measureWrappedHeight(desc, contentWidth - 24, 11.5, 8.6, 'normal');
      const boxH = 12 + hMeas.height + (desc ? dMeas.height + 2 : 0);

      ensureSpace(boxH + 6);
      doc.setFillColor(...COLORS.surface);
      doc.setDrawColor(...COLORS.border);
      doc.roundedRect(marginX, y, contentWidth, boxH, 4, 4, 'FD');

      let cy = y + 14;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9.2);
      doc.setTextColor(...COLORS.ink);
      for (const line of hMeas.lines) {
        doc.text(line, marginX + 12, cy);
        cy += 12;
      }
      if (desc) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.6);
        doc.setTextColor(...COLORS.body);
        for (const line of dMeas.lines) {
          doc.text(line, marginX + 12, cy);
          cy += 11.5;
        }
      }
      y += boxH + 6;
    }

    if (latestEdges.length > 0) {
      const nameById = new Map(latestModules.map((m) => [m.id, m.name]));
      const flowStrings = latestEdges
        .slice(0, 6)
        .map((e) => `${nameById.get(e.from) || e.from} -> ${nameById.get(e.to) || e.to} (${e.protocol})`);
      drawWrapped(
        `Data Flows: ${flowStrings.join('  |  ')}`,
        marginX + 4,
        contentWidth - 8,
        12,
        8.5,
        COLORS.muted,
        'normal'
      );
      y += 6;
    }
    y += 6;
  }

  // --- Section: Key Architectural Milestones ---
  if (keyMilestones.length > 0) {
    drawSectionHeading(
      `${sectionNum++}. Key Architectural Milestones (Read First)`,
      'Commits that introduced major design shifts, new subsystems, or performance breakthroughs.'
    );

    keyMilestones.forEach((c) => {
      const tagLabel = c.tag ? ` (${c.tag})` : '';
      const titleText = `[${c.shortSha}]${tagLabel} ${c.title}`;
      const metaText = `${c.author || 'Contributor'}  |  ${
        c.timestamp?.split(' ')[0] || '-'
      }  |  ${c.category}`;
      const problemText = c.adr?.problemStatement ? `Why: ${c.adr.problemStatement}` : '';
      const decisionText = c.adr?.decisionSummary
        ? `Decision: ${c.adr.decisionSummary}`
        : c.message
          ? `Decision: ${c.message}`
          : '';
      const outcomeText = c.adr?.measurableOutcome ? `Outcome: ${c.adr.measurableOutcome}` : '';

      const innerW = contentWidth - 26;
      const tMeas = measureWrappedHeight(titleText, innerW, 13, 10, 'bold');
      const pMeas = problemText ? measureWrappedHeight(problemText, innerW, 12, 8.8, 'normal') : null;
      const dMeas = decisionText ? measureWrappedHeight(decisionText, innerW, 12, 8.8, 'normal') : null;
      const oMeas = outcomeText ? measureWrappedHeight(outcomeText, innerW, 12, 8.6, 'bold') : null;

      const cardH =
        16 +
        tMeas.height +
        12 +
        (pMeas ? pMeas.height + 3 : 0) +
        (dMeas ? dMeas.height + 3 : 0) +
        (oMeas ? oMeas.height + 2 : 0) +
        4;

      ensureSpace(cardH + 8);
      doc.setFillColor(...COLORS.surface);
      doc.setDrawColor(...COLORS.border);
      doc.roundedRect(marginX, y, contentWidth, cardH, 4, 4, 'FD');

      doc.setFillColor(...COLORS.amberBar);
      doc.rect(marginX, y, 3.5, cardH, 'F');

      let cy = y + 15;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...COLORS.ink);
      for (const line of tMeas.lines) {
        doc.text(line, marginX + 14, cy);
        cy += 13;
      }

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.2);
      doc.setTextColor(...COLORS.muted);
      doc.text(pdfSafeText(metaText), marginX + 14, cy);
      cy += 13;

      if (pMeas) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.8);
        doc.setTextColor(...COLORS.body);
        for (const line of pMeas.lines) {
          doc.text(line, marginX + 14, cy);
          cy += 12;
        }
        cy += 3;
      }

      if (dMeas) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.8);
        doc.setTextColor(...COLORS.body);
        for (const line of dMeas.lines) {
          doc.text(line, marginX + 14, cy);
          cy += 12;
        }
        cy += 3;
      }

      if (oMeas) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.6);
        doc.setTextColor(...COLORS.greenText);
        for (const line of oMeas.lines) {
          doc.text(line, marginX + 14, cy);
          cy += 12;
        }
      }

      y += cardH + 8;
    });
  }

  // --- Section: Chronological Commit Digest ---
  if (commits.length > 0) {
    drawSectionHeading(
      `${sectionNum++}. Step-by-Step Commit Digest (${commits.length} Commits)`,
      savedNoteCount > 0
        ? `Includes ${savedNoteCount} saved developer note(s) highlighted in amber.`
        : 'Chronological story from earliest imported commit to latest.'
    );

    commits.forEach((c, idx) => {
      const dateStr = c.timestamp?.split(' ')[0] || '-';
      const headerLine = `Step ${idx + 1}: [${c.shortSha}] ${c.title}`;
      const filesPart =
        c.files && c.files.length > 0
          ? `  |  Files: ${c.files
              .slice(0, 3)
              .map((f) => f.path.split('/').pop() || f.path)
              .join(', ')}${c.files.length > 3 ? ` (+${c.files.length - 3})` : ''}`
          : '';
      const metaLine = `${dateStr}  |  ${c.category}  |  ${c.author || 'Contributor'}${filesPart}`;
      const rawSummary = c.adr?.decisionSummary || c.message || 'No summary available.';
      const summary = rawSummary.length > 260 ? `${rawSummary.slice(0, 257)}...` : rawSummary;
      const note = annotations[c.sha]?.trim() || '';

      const innerW = contentWidth - 18;
      const hMeas = measureWrappedHeight(headerLine, innerW, 12.5, 9.5, 'bold');
      const sMeas = measureWrappedHeight(summary, innerW - 6, 11.5, 8.6, 'normal');
      const nMeas = note ? measureWrappedHeight(`Note: ${note}`, innerW - 8, 11.5, 8.4, 'bold') : null;

      ensureSpace(hMeas.height + 12 + Math.min(sMeas.height, 24));

      drawWrapped(headerLine, marginX + 4, innerW, 12.5, 9.5, COLORS.ink, 'bold');
      drawWrapped(metaLine, marginX + 10, innerW - 6, 11, 8, COLORS.muted, 'normal');
      drawWrapped(summary, marginX + 10, innerW - 6, 11.5, 8.6, COLORS.body, 'normal');

      if (nMeas) {
        ensureSpace(nMeas.height + 10);
        doc.setFillColor(...COLORS.amberSoftBg);
        doc.setDrawColor(...COLORS.amberSoftBorder);
        doc.roundedRect(marginX + 10, y - 8, innerW - 6, nMeas.height + 6, 3, 3, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.4);
        doc.setTextColor(...COLORS.amber);
        let ny = y + 2;
        for (const line of nMeas.lines) {
          doc.text(line, marginX + 16, ny);
          ny += 11.5;
        }
        y += nMeas.height + 4;
      }

      y += 4;
      doc.setDrawColor(...COLORS.border);
      doc.setLineWidth(0.4);
      doc.line(marginX, y, pageWidth - marginX, y);
      y += 10;
    });
  }

  // --- Page Footers ---
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...COLORS.border);
    doc.setLineWidth(0.5);
    doc.line(marginX, pageHeight - 32, pageWidth - marginX, pageHeight - 32);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLORS.muted);
    doc.text(
      pdfSafeText(`GitReplay Onboarding Brief  |  ${repo.owner}/${repo.name}`),
      marginX,
      pageHeight - 19
    );
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - marginX, pageHeight - 19, {
      align: 'right',
    });
  }

  doc.save(`${repo.name}-onboarding-summary.pdf`);
}
