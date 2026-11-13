import argparse
import click
import typer
parser = argparse.ArgumentParser()
parser.add_argument('--count', dest='total')
def run():
    args = parser.parse_args()
    def shadow(args):
        return args.total
    return args.total
def unrelated(count):
    return count
def unrelated_args(args):
    return args.total
other = argparse.ArgumentParser()
def other_parser():
    args = other.parse_args()
    return args.total
@click.option('--output-dir', 'output')
def clicked(output):
    return output
def typed(output: str = typer.Option('', '--output-dir')):
    return output
