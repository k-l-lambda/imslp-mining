import fs from 'fs';
import path from 'path';
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';


type Boundary = {
	measureIndex?: number;
	matchScore?: number;
};


type Segmentation = {
	spartitoMeasureCount?: number;
	boundaries?: Boundary[];
};


type ScoreStats = {
	id: string;
	spartitoMeasures: number;
	annotatedMeasures: number;
	status: Status;
	reason: string;
};


type Status = 'completed' | 'hard-failed' | 'soft-failed' | 'in-progress';


const argv = yargs(hideBin(process.argv))
	.command(
		'$0 source',
		'Count MIDI annotation progress for score directories.',
		yargs => yargs
			.positional('source', { type: 'string', demandOption: true, description: 'directory containing score subdirectories' })
			.option('log-dir', { type: 'string', description: 'batch log directory containing per-score *.log files' })
			.option('log', { type: 'string', description: 'aggregate batch log file used to classify failures' })
			.option('json', { type: 'boolean', default: false, description: 'print JSON instead of text tables' })
	)
	.help()
	.argv as { source: string; logDir?: string; log?: string; json?: boolean };


const STATUS_LABEL: Record<Status, string> = {
	completed: 'completed',
	'hard-failed': 'hard-failed',
	'soft-failed': 'soft-failed',
	'in-progress': 'in-progress',
};


const readJson = (filePath: string) => JSON.parse(fs.readFileSync(filePath).toString());


const countSpartitoMeasures = (scoreDir: string) => {
	const spartitoPath = path.join(scoreDir, 'spartito.json');
	if (!fs.existsSync(spartitoPath))
		return 0;
	const spartito = readJson(spartitoPath);
	return Array.isArray(spartito.measures) ? spartito.measures.length : 0;
};


const readSegmentation = (scoreDir: string): Segmentation | null => {
	const segmentationPath = path.join(scoreDir, '.measures', 'midi-segmentation.json');
	if (!fs.existsSync(segmentationPath))
		return null;
	return readJson(segmentationPath) as Segmentation;
};


const hasConsecutiveLowMatch = (boundaries: Boundary[]) => {
	const sorted = boundaries
		.filter(boundary => Number.isFinite(Number(boundary.measureIndex)))
		.sort((a, b) => Number(a.measureIndex) - Number(b.measureIndex));
	for (let i = 1; i < sorted.length; ++i) {
		const previous = sorted[i - 1];
		const current = sorted[i];
		if (Number(current.measureIndex) !== Number(previous.measureIndex) + 1)
			continue;
		if (Number(previous.matchScore ?? 1) < 0.4 && Number(current.matchScore ?? 1) < 0.4)
			return true;
	}
	return false;
};


const readLogs = (logDir: string | undefined, logFile: string | undefined, scoreId: string) => {
	let log = '';
	if (logDir) {
		const logPath = path.join(logDir, `${scoreId}.log`);
		if (fs.existsSync(logPath))
			log += fs.readFileSync(logPath).toString();
	}
	if (logFile && fs.existsSync(logFile))
		log += fs.readFileSync(logFile).toString();
	return log;
};


const hasHardFailureInLog = (log: string, scoreId: string) => {
	const failedIndex = log.indexOf(`FAILED ${scoreId}`);
	if (failedIndex < 0)
		return false;
	const context = log.slice(Math.max(0, failedIndex - 2000), failedIndex);
	return context.includes('consecutive low matchScore boundaries');
};


const classify = (scoreDir: string, logDir: string | undefined, logFile: string | undefined): ScoreStats => {
	const id = path.basename(scoreDir);
	const spartitoMeasures = countSpartitoMeasures(scoreDir);
	const segmentation = readSegmentation(scoreDir);
	const boundaries = segmentation?.boundaries ?? [];
	const annotatedMeasures = boundaries.length;
	const expectedBoundaries = Math.max(0, spartitoMeasures - 1);
	const log = readLogs(logDir, logFile, id);
	const done = log.includes(`OK ${id}`) || (expectedBoundaries > 0 && annotatedMeasures >= expectedBoundaries);
	const failed = log.includes(`FAILED ${id}`);
	const hardFailed = hasHardFailureInLog(log, id) || hasConsecutiveLowMatch(boundaries);

	if (done)
		return { id, spartitoMeasures, annotatedMeasures, status: 'completed', reason: 'segmentation complete' };
	if (hardFailed)
		return { id, spartitoMeasures, annotatedMeasures, status: 'hard-failed', reason: 'consecutive low matchScore boundaries' };
	if (failed)
		return { id, spartitoMeasures, annotatedMeasures, status: 'soft-failed', reason: 'batch log contains FAILED' };
	return { id, spartitoMeasures, annotatedMeasures, status: 'in-progress', reason: annotatedMeasures ? 'partial segmentation exists' : 'not started' };
};


const scoreDirs = (source: string) => fs.readdirSync(source, { withFileTypes: true })
	.filter(entry => entry.isDirectory())
	.map(entry => path.join(source, entry.name))
	.filter(scoreDir => fs.existsSync(path.join(scoreDir, 'spartito.json')));


const printText = (stats: ScoreStats[]) => {
	const totals = stats.reduce((acc, item) => {
		++acc.count;
		++acc.statusCounts[item.status];
		acc.spartitoMeasures += item.spartitoMeasures;
		acc.annotatedMeasures += item.annotatedMeasures;
		acc.byStatus[item.status].count += 1;
		acc.byStatus[item.status].spartitoMeasures += item.spartitoMeasures;
		acc.byStatus[item.status].annotatedMeasures += item.annotatedMeasures;
		return acc;
	}, {
		count: 0,
		spartitoMeasures: 0,
		annotatedMeasures: 0,
		statusCounts: {
			completed: 0,
			'hard-failed': 0,
			'soft-failed': 0,
			'in-progress': 0,
		} as Record<Status, number>,
		byStatus: {
			completed: { count: 0, spartitoMeasures: 0, annotatedMeasures: 0 },
			'hard-failed': { count: 0, spartitoMeasures: 0, annotatedMeasures: 0 },
			'soft-failed': { count: 0, spartitoMeasures: 0, annotatedMeasures: 0 },
			'in-progress': { count: 0, spartitoMeasures: 0, annotatedMeasures: 0 },
		} as Record<Status, { count: number; spartitoMeasures: number; annotatedMeasures: number }>,
	});

	console.log('summary');
	console.log(`scores=${totals.count} annotatedMeasures=${totals.annotatedMeasures} spartitoMeasures=${totals.spartitoMeasures}`);
	console.log('');
	console.log('status\tcount\tannotatedMeasures\tspartitoMeasures');
	for (const status of ['completed', 'hard-failed', 'soft-failed', 'in-progress'] as Status[]) {
		const item = totals.byStatus[status];
		console.log(`${STATUS_LABEL[status]}\t${item.count}\t${item.annotatedMeasures}\t${item.spartitoMeasures}`);
	}

	console.log('');
	console.log('id\tstatus\tannotatedMeasures\tspartitoMeasures\treason');
	for (const item of stats.sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id)))
		console.log(`${item.id}\t${STATUS_LABEL[item.status]}\t${item.annotatedMeasures}\t${item.spartitoMeasures}\t${item.reason}`);
};


const main = () => {
	const source = path.resolve(argv.source);
	if (!fs.existsSync(source) || !fs.statSync(source).isDirectory())
		throw new Error(`source directory not found: ${source}`);
	const logDir = argv.logDir ? path.resolve(argv.logDir) : undefined;
	const logFile = argv.log ? path.resolve(argv.log) : undefined;
	const stats = scoreDirs(source).map(scoreDir => classify(scoreDir, logDir, logFile));

	if (argv.json) {
		console.log(JSON.stringify({ source, logDir, logFile, scores: stats }, null, 2));
		return;
	}
	printText(stats);
};


main();
