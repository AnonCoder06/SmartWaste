class ClientError(Exception):
    def __init__(self, error_response, operation_name):
        super().__init__(f"{operation_name}: {error_response['Error']['Code']}")
        self.response = error_response
        self.operation_name = operation_name
