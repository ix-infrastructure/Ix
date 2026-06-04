import { describe, it, expect } from 'vitest';
import { parseFile } from '../index.js';
import { SupportedLanguages } from '../languages.js';

const h = parseFile('/repo/m.tf', 'variable "x" {}\n');
const describeFn = h && h.language === SupportedLanguages.HCL ? describe : describe.skip;

describeFn('HCL queries', () => {
  it('detects HCL by .tf / .tfvars / .hcl', () => {
    expect(parseFile('/r/main.tf', 'variable "x" {}')!.language).toBe(SupportedLanguages.HCL);
    expect(parseFile('/r/vars.tfvars', 'x = 1')!.language).toBe(SupportedLanguages.HCL);
  });

  it('captures resource/variable/output/module/data blocks by primary name', () => {
    const result = parseFile('/r/main.tf', `
resource "aws_instance" "web" { ami = "ami-123" }
variable "region" { default = "us-east-1" }
output "ip" { value = aws_instance.web.private_ip }
data "aws_ami" "ubuntu" { most_recent = true }
`);
    expect(result).not.toBeNull();
    const names = result!.entities.map(e => e.name);
    expect(names).toEqual(expect.arrayContaining(['web', 'region', 'ip', 'ubuntu']));
    expect(names).not.toContain('aws_instance');
  });

  it('emits IMPORTS for module source', () => {
    const result = parseFile('/r/main.tf', `
module "vpc" { source = "terraform-aws-modules/vpc/aws" }
module "db" { source = "./modules/db" }
`);
    expect(result).not.toBeNull();
    const imports = result!.relationships
      .filter(r => r.predicate === 'IMPORTS')
      .map(r => r.importRaw ?? r.dstName);
    expect(imports).toEqual(
      expect.arrayContaining(['terraform-aws-modules/vpc/aws', './modules/db']),
    );
  });
});
