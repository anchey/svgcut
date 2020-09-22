/* Copyright 2020 Ricardo Iván Vieitez Parra
 *
 * All rights reserved.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 */

import { Decimal } from 'decimal.js';
import { Parser } from 'xml2js';
import { Strategy, reorderPaths } from './reorderPaths';

Decimal.set({ toExpPos: 9e15, toExpNeg: -9e15 });

interface viewBox {
	minX: Decimal;
	minY: Decimal;
	width: Decimal;
	height: Decimal;
}

interface SvgDocument {
	properties: {
		width: Decimal;
		height: Decimal;
		viewBox?: viewBox;
		version: string;
	};
	paths: string[];
	unit: SvgUnit;
}

type SvgUnit = 'em' | 'ex' | 'px' | 'in' | 'cm' | 'mm' | 'pt' | 'pc' | '%';

const convertPx = (
	length: Decimal,
	baseLength: Decimal,
	mode: 'FROM_PX' | 'TO_PX',
	unit?: SvgUnit,
) => {
	let scale: number | Decimal = 1;

	if (unit) {
		switch (unit) {
			case 'em':
				// Taking a guess 1em = 1pc
				scale = 16;
				break;
			case 'ex':
				// Taking a guess 1ex = 0.5em = 0.5pc
				scale = 8;
				break;
			case 'px':
				scale = 1;
				break;
			case 'in':
				scale = 96;
				break;
			case 'cm':
				scale = 9600 / 254;
				break;
			case 'mm':
				scale = 960 / 254;
				break;
			case 'pt':
				scale = 96 / 72;
				break;
			case 'pc':
				scale = 16;
				break;
			case '%':
				scale = baseLength.mul(length).div(100);
				break;
		}
	}

	return mode === 'TO_PX' ? length.mul(scale) : length.div(scale);
};

const parseLength = (value: string) => {
	const match = value.match(
		/^\s*([+-]?[0-9]+(?:[Ee][+-]?[0-9]+)?|[+-]?[0-9]*[.][0-9]+(?:[Ee][+-]?[0-9]+)?)(em|ex|px|in|cm|mm|pt|pc|%)?\s*$/,
	);
	if (match) {
		return {
			length: new Decimal(match[1]),
			unit: match[2] as SvgUnit,
		};
	}
};

const parseLengthAndScale = (value: string, baseLength: Decimal) => {
	const parsed = parseLength(value);
	if (parsed) {
		const scaledLength = convertPx(
			parsed.length,
			baseLength,
			'TO_PX',
			parsed.unit,
		);

		if (scaledLength.isFinite()) {
			return scaledLength;
		}
	}
};

const extractSvgDocumentPaths = async (
	data: Buffer | string,
): Promise<SvgDocument[]> => {
	const parser = new Parser({
		xmlns: true,
		preserveChildrenOrder: true,
		explicitChildren: true,
	});

	const result = await parser.parseStringPromise(data);

	const documents: SvgDocument[] = [];

	const zero = new Decimal(0);

	// eslint-disable-next-line @typescript-eslint/ban-types
	const extractPaths = (tree: object, document: SvgDocument | null) => {
		for (const el of Object.values(tree)) {
			if (el['$ns']['uri'] === 'http://www.w3.org/2000/svg') {
				if (el['$ns']['local'] === 'svg') {
					if (document) {
						throw new Error('Invalid nested document');
					}

					document = {
						properties: {
							width: new Decimal(300),
							height: new Decimal(150),
							version: '1.1',
						},
						paths: [],
						unit: 'px',
					};
					documents.push(document);

					for (const attr of Object.values(el['$'])) {
						if (
							attr instanceof Object &&
							'uri' in attr &&
							'local' in attr &&
							'value' in attr &&
							['http://www.w3.org/2000/svg', ''].includes(
								attr['uri'],
							)
						) {
							switch (attr['local']) {
								case 'width': {
									const parsed = parseLength(attr['value']);
									if (parsed) {
										document.properties.width = convertPx(
											parsed.length,
											document.properties.width,
											'TO_PX',
											parsed.unit,
										);
										document.unit = parsed.unit;
									}
									break;
								}
								case 'height': {
									const parsed = parseLength(attr['value']);
									if (parsed) {
										document.properties.height = convertPx(
											parsed.length,
											document.properties.height,
											'TO_PX',
											parsed.unit,
										);
										document.unit = parsed.unit;
									}
									break;
								}
								case 'viewBox':
									{
										const viewBox = /*String(
											attr['value'],
										).match(
											/^([+-]?[0-9]+(?:[Ee][+-]?[0-9]+)?|[+-]?[0-9]*\.[0-9]+(?:[Ee][+-]?[0-9]+))(?:\s+|\s*,\s*)([+-]?[0-9]+(?:[Ee][+-]?[0-9]+)?|[+-]?[0-9]*\.[0-9]+(?:[Ee][+-]?[0-9]+))(?:\s+|\s*,\s*)([+]?[0-9]+(?:[Ee][+-]?[0-9]+)?|[+-]?[0-9]*\.[0-9]+(?:[Ee][+-]?[0-9]+))(?:\s+|\s*,\s*)([+]?[0-9]+(?:[Ee][+-]?[0-9]+)?|[+-]?[0-9]*\.[0-9]+(?:[Ee][+-]?[0-9]+))$/,
										);*/ (attr[
											'value'
										] as string).split(' ');
										if (viewBox) {
											document.properties.viewBox = {
												minX: new Decimal(viewBox[0]),
												minY: new Decimal(viewBox[1]),
												width: new Decimal(viewBox[2]),
												height: new Decimal(viewBox[3]),
											};
										}
									}
									break;
								case 'version':
									document.properties.version = attr['value'];
									break;
							}
						}
					}
				} else if (document === null) {
					continue;
				} else {
					const baseLengthX =
						document.properties.viewBox?.width ||
						document.properties.width;
					const baseLengthY =
						document.properties.viewBox?.height ||
						document.properties.height;
					const baseLength = baseLengthX
						.pow(2)
						.plus(baseLengthY.pow(2))
						.div(2)
						.sqrt();

					switch (el['$ns']['local']) {
						case 'circle':
							{
								let cx: Decimal = zero,
									cy: Decimal = zero,
									r: Decimal = zero;

								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri'])
									) {
										switch (attr['local']) {
											case 'cx':
												cx =
													parseLengthAndScale(
														attr['value'],
														baseLengthX,
													) || cx;
												break;
											case 'cy':
												cy =
													parseLengthAndScale(
														attr['value'],
														baseLengthY,
													) || cy;
												break;
											case 'r':
												r =
													parseLengthAndScale(
														attr['value'],
														baseLength,
													) || r;
												break;
										}
									}
								}
								if (r.lte(0)) {
									document.paths.push(`M${cx} ${cy}`);
								} else {
									document.paths.push(
										`M${cx.sub(r)} ${cy}` +
											`a ${r} ${r} 0 1 1 ${r} ${r}` +
											`a ${r} ${r} 0 0 1 ${r.neg()} ${r.neg()}` +
											`Z`,
									);
								}
							}
							break;
						case 'ellipse':
							{
								let cx: Decimal = zero,
									cy: Decimal = zero,
									rx: Decimal | null = null,
									ry: Decimal | null = null;

								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri'])
									) {
										switch (attr['local']) {
											case 'cx':
												cx =
													parseLengthAndScale(
														attr['value'],
														baseLengthX,
													) || cx;
												break;
											case 'cy':
												cy =
													parseLengthAndScale(
														attr['value'],
														baseLengthY,
													) || cy;
												break;
											case 'rx':
												if (attr['value'] !== 'auto') {
													rx =
														parseLengthAndScale(
															attr['value'],
															baseLengthX,
														) || rx;
												}
												break;
											case 'ry':
												if (attr['value'] !== 'auto') {
													ry =
														parseLengthAndScale(
															attr['value'],
															baseLengthY,
														) || ry;
												}
												break;
										}
									}
								}

								if (rx === null && ry !== null) {
									rx = ry;
								} else if (rx !== null && ry === null) {
									ry = rx;
								} else if (rx === null && ry === null) {
									rx = ry = zero;
								}

								if (rx !== null && ry !== null) {
									if (rx.lte(0) || ry.lte(0)) {
										document.paths.push(`M${cx} ${cy}`);
									} else {
										document.paths.push(
											`M${cx.sub(rx)} ${cy}` +
												`a ${rx} ${ry} 0 1 1 ${rx} ${ry}` +
												`a ${rx} ${ry} 0 0 1 ${rx.neg()} ${ry.neg()}` +
												`Z`,
										);
									}
								}
							}
							break;
						case 'line':
							{
								let x1: Decimal = zero,
									x2: Decimal = zero,
									y1: Decimal = zero,
									y2: Decimal = zero;

								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri'])
									) {
										switch (attr['local']) {
											case 'x1':
												x1 =
													parseLengthAndScale(
														attr['value'],
														baseLengthX,
													) || x1;
												break;
											case 'x2':
												x2 =
													parseLengthAndScale(
														attr['value'],
														baseLengthX,
													) || x2;
												break;
											case 'y1':
												y1 =
													parseLengthAndScale(
														attr['value'],
														baseLengthY,
													) || y1;
												break;
											case 'y2':
												y2 =
													parseLengthAndScale(
														attr['value'],
														baseLengthY,
													) || y2;
												break;
										}
									}
								}
								document.paths.push(`M${x1} ${y1} ${x2} ${y2}`);
							}
							break;
						case 'path':
							{
								let d = '';
								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri']) &&
										attr['local'] === 'd'
									) {
										d = attr['value'] || '';
										break;
									}
								}
								document.paths.push(d);
							}
							break;
						case 'polygon':
							{
								let points = '';
								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri']) &&
										attr['local'] === 'points'
									) {
										points = attr['value'] || points;
										break;
									}
								}
								document.paths.push(`M${points}Z`);
							}
							break;
						case 'polyline':
							{
								let points = '';
								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri']) &&
										attr['local'] === 'points'
									) {
										points = attr['value'] || points;
										break;
									}
								}
								document.paths.push(`M${points}`);
							}
							break;
						case 'rect':
							{
								let x: Decimal = zero,
									y: Decimal = x,
									rx: Decimal | null = null,
									ry: Decimal | null = null,
									width: Decimal = x,
									height: Decimal = zero;

								for (const attr of Object.values(
									el['$'] || {},
								)) {
									if (
										attr instanceof Object &&
										'uri' in attr &&
										'local' in attr &&
										[
											'http://www.w3.org/2000/svg',
											'',
										].includes(attr['uri'])
									) {
										switch (attr['local']) {
											case 'x':
												x =
													parseLengthAndScale(
														attr['value'],
														baseLengthX,
													) || x;
												break;
											case 'y':
												y =
													parseLengthAndScale(
														attr['value'],
														baseLengthY,
													) || y;
												break;
											case 'rx':
												if (attr['value'] !== 'auto') {
													rx =
														parseLengthAndScale(
															attr['value'],
															baseLengthX,
														) || rx;
												}
												break;
											case 'ry':
												if (attr['value'] !== 'auto') {
													ry =
														parseLengthAndScale(
															attr['value'],
															baseLengthY,
														) || ry;
												}
												break;
											case 'width':
												width =
													parseLengthAndScale(
														attr['value'],
														baseLengthX,
													) || width;
												break;
											case 'height':
												height =
													parseLengthAndScale(
														attr['value'],
														baseLengthY,
													) || height;
												break;
										}
									}
								}

								if (rx === null && ry !== null) {
									rx = ry;
								} else if (rx !== null && ry === null) {
									ry = rx;
								} else if (rx === null && ry === null) {
									rx = ry = zero;
								}

								if (width.lte(0) || height.lte(0)) {
									document.paths.push(`M ${x} ${y}`);
								} else if (
									rx === null ||
									ry === null ||
									rx.lte(0) ||
									ry.lte(0)
								) {
									document.paths.push(
										`M ${x} ${y}` +
											`h ${width}` +
											`v ${height}` +
											`h ${width.neg()}` +
											`v ${height.neg()}` +
											`Z`,
									);
								} else if (
									rx.lte(width.div(2)) &&
									ry.lte(height.div(2))
								) {
									document.paths.push(
										`M ${x.plus(rx)} ${y}` +
											`h ${width.sub(rx.mul(2))}` +
											`a ${rx} ${ry} 0 0 1 ${rx} ${ry}` +
											`v ${height.sub(ry.mul(2))}` +
											`a ${rx} ${ry} 0 0 1 ${rx.neg()} ${ry}` +
											`h ${rx.mul(2).sub(width)}` +
											`a ${rx} ${ry} 0 0 1 ${rx.neg()} ${ry.neg()}` +
											`v ${ry.mul(2).sub(height)}` +
											`a ${rx} ${ry} 0 0 1 ${rx} ${ry.neg()}` +
											`Z`,
									);
								} else if (rx.lte(width.div(2))) {
									document.paths.push(
										`M ${x.plus(rx)} ${y}` +
											`h ${width.sub(rx.mul(2))}` +
											`a ${rx} ${height.div(
												2,
											)} 0 1 1 0 ${height}` +
											`h ${rx.mul(2).sub(width)}` +
											`a ${rx} ${height.div(
												2,
											)} 0 1 1 0 ${height.neg()}` +
											`Z`,
									);
								} else if (ry.lte(height.div(2))) {
									document.paths.push(
										`M ${x.plus(width)} ${y.plus(ry)}` +
											`v ${height.sub(ry.mul(2))}` +
											`a ${width.div(
												2,
											)} ${ry} 0 0 1 ${-width} 0` +
											`v ${ry.mul(2).sub(height)}` +
											`a ${width.div(
												2,
											)} ${ry} 0 0 1 ${width} 0` +
											`Z`,
									);
								} else {
									document.paths.push(
										`M ${x.plus(width)} ${y.plus(
											height.div(2),
										)}` +
											`a ${width.div(2)} ${height.div(
												2,
											)} 0 0 1 ${width.neg()} 0` +
											`a ${width.div(2)} ${height.div(
												2,
											)} 0 0 1 ${width} 0` +
											`Z`,
									);
								}
							}
							break;
					}
				}
			}
			if (el['$$'] && Array.isArray(el['$$']) && el['$$'].length) {
				extractPaths(el['$$'], document);
			}
		}
	};

	extractPaths(result, null);

	return documents;
};

const reconstructSvgDocuments = (documents: SvgDocument[]): string[] => {
	return documents.map((document) => {
		const scaledWidth = convertPx(
			document.properties.width,
			document.properties.width,
			'FROM_PX',
			document.unit,
		);
		const scaledHeight = convertPx(
			document.properties.height,
			document.properties.height,
			'FROM_PX',
			document.unit,
		);
		return `<svg width="${scaledWidth}${
			document.unit
		}" height="${scaledHeight}${document.unit}" version="${
			document.properties.version
		}" ${
			document.properties.viewBox
				? `viewBox="${document.properties.viewBox.minX} ${document.properties.viewBox.minY} ${document.properties.viewBox.width} ${document.properties.viewBox.height}"`
				: ''
		} xmlns="http://www.w3.org/2000/svg"><style type="text/css">path{fill:none;stroke:#000000;stroke-width:1px;stroke-linecap:butt;stroke-linejoin:miter;stroke-opacity:1;}</style><g>${
			document.paths.length
				? document.paths.map((path) => `<path d="${path}" />`).join('')
				: ''
		}</g></svg>`;
	});
};

export const reorderSvgPaths = async (
	input: Buffer | string,
	strategy: Strategy,
): Promise<string[]> => {
	const documents = await extractSvgDocumentPaths(input);

	const reorderedDocuments = documents.map((document) => {
		const reorderedPaths = reorderPaths(
			document.paths,
			strategy,
			document.properties.viewBox
				? [
						document.properties.viewBox.minX,
						document.properties.viewBox.minY,
				  ]
				: undefined,
		);
		document.paths = reorderedPaths;
		return document;
	});

	return reconstructSvgDocuments(reorderedDocuments);
};
