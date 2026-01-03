import fs from 'fs';

export interface CSVParseOptions {
    delimiter?: string;
    hasHeader?: boolean;
}

export class CSVUtils {
    /**
     * Simple CSV parser (supports basic CSV without complex quoted fields)
     */
    static async parseCSV(filePath: string, options: CSVParseOptions = {}): Promise<any[]> {
        const { delimiter = ',', hasHeader = true } = options;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter(line => line.trim() !== '');

        if (lines.length === 0) return [];

        let headers: string[] = [];
        let startLine = 0;

        if (hasHeader) {
            headers = lines[0].split(delimiter).map(h => h.trim());
            startLine = 1;
        }

        const results = [];
        for (let i = startLine; i < lines.length; i++) {
            const values = lines[i].split(delimiter).map(v => v.trim());
            const obj: any = {};

            if (hasHeader) {
                headers.forEach((header, index) => {
                    obj[header] = values[index];
                });
            } else {
                results.push(values);
                continue;
            }
            results.push(obj);
        }

        return results;
    }
}
